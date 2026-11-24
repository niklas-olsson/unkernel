// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk descriptor test: a set's storage buffers written by ONE
// VkWriteDescriptorSet at binding 0 whose descriptorCount spills over into
// the following bindings (Vulkan's consecutive binding updates: past a zero-
// count binding, into a descriptor array and on), as ggml-vulkan writes its
// sets; then the same through VkCopyDescriptorSet and through a descriptor
// update template. A compute shader (sets.comp) writes buffers bound at
// bindings 2, 3 and a dynamic storage buffer at 4, all in host-visible
// memory mapped once; after each fence wait the mapped bytes are read
// directly (HOST_COHERENT: no invalidate). Also checked: bytes of a bound
// range the shader does not write, changed by the CPU while the GPU works,
// keep the CPU's value; parts of the dynamic buffer outside the bound
// range keep theirs. Exit 0 on success.
#include "vk-common.h"

#include "sets_comp.h"

#define N 1024u
#define EXTRA 16u /* words past N in each output: bound, never written by the shader */
#define LEAD 64u /* out3 is bound from this word on */

struct buf {
	VkBuffer b;
	VkDeviceMemory m;
	uint32_t *p;
};

static void mkbuf(struct ctx *c, struct buf *b, VkDeviceSize size)
{
	host_buffer(c, size, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, &b->b, &b->m);
	CHECK(vkMapMemory(c->dev, b->m, 0, VK_WHOLE_SIZE, 0, (void **)&b->p));
	memset(b->p, 0, size);
}

static int bad;
static void expect(const char *what, uint32_t i, uint32_t got, uint32_t want)
{
	if (got == want)
		return;
	if (bad < 8)
		fprintf(stderr, "%s[%u] = %u, want %u\n", what, i, got, want);
	bad++;
}

int main(void)
{
	struct ctx c;
	ctx_init(&c, "vk-sets");
	VkPhysicalDeviceProperties props;
	vkGetPhysicalDeviceProperties(c.pd, &props);
	VkDeviceSize align = props.limits.minStorageBufferOffsetAlignment;
	VkDeviceSize stride = (N * 4 + align - 1) / align * align; /* one dynamic region per run */

	struct buf src, a0, a1, o3, dyn;
	mkbuf(&c, &src, N * 4);
	mkbuf(&c, &a0, (N + EXTRA) * 4);
	mkbuf(&c, &a1, (N + EXTRA) * 4);
	mkbuf(&c, &o3, (LEAD + N + EXTRA) * 4);
	mkbuf(&c, &dyn, 3 * stride);
	for (uint32_t i = 0; i < N; i++)
		src.p[i] = i + 1;
	for (uint32_t i = 0; i < LEAD; i++)
		o3.p[i] = 0xa0000000u + i;

	VkDescriptorSetLayoutBinding lb[5] = {
		{0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
		{1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 0, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
		{2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 2, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
		{3, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
		{4, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
	};
	VkDescriptorSetLayoutCreateInfo lci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 5, .pBindings = lb};
	VkDescriptorSetLayout dsl;
	CHECK(vkCreateDescriptorSetLayout(c.dev, &lci, NULL, &dsl));
	VkPushConstantRange pcr = {VK_SHADER_STAGE_COMPUTE_BIT, 0, 8};
	VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &dsl,
		.pushConstantRangeCount = 1, .pPushConstantRanges = &pcr};
	VkPipelineLayout pl;
	CHECK(vkCreatePipelineLayout(c.dev, &plci, NULL, &pl));
	VkComputePipelineCreateInfo cpci = {.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
		.stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
			.module = shader(&c, spv_sets_comp, sizeof spv_sets_comp), .pName = "main"},
		.layout = pl};
	VkPipeline pipe;
	CHECK(vkCreateComputePipelines(c.dev, VK_NULL_HANDLE, 1, &cpci, NULL, &pipe));

	VkDescriptorPoolSize ps[2] = {{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 12}, {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, 3}};
	VkDescriptorPoolCreateInfo dpci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 3, .poolSizeCount = 2, .pPoolSizes = ps};
	VkDescriptorPool dp;
	CHECK(vkCreateDescriptorPool(c.dev, &dpci, NULL, &dp));
	VkDescriptorSetLayout dsls[3] = {dsl, dsl, dsl};
	VkDescriptorSetAllocateInfo dsai = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dp,
		.descriptorSetCount = 3, .pSetLayouts = dsls};
	VkDescriptorSet sets[3];
	CHECK(vkAllocateDescriptorSets(c.dev, &dsai, sets));

	/* run 0: one write from binding 0 over 4 descriptors: src -> 0, (1 has
	 * none), a0 -> 2[0], a1 -> 2[1], o3 -> 3; the dynamic one on its own */
	VkDescriptorBufferInfo bi[5] = {
		{src.b, 0, VK_WHOLE_SIZE},
		{a0.b, 0, VK_WHOLE_SIZE},
		{a1.b, 0, VK_WHOLE_SIZE},
		{o3.b, LEAD * 4, VK_WHOLE_SIZE},
		{dyn.b, 0, N * 4},
	};
	VkWriteDescriptorSet w[2] = {
		{.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 0, .descriptorCount = 4,
			.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = bi},
		{.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 4, .descriptorCount = 1,
			.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, .pBufferInfo = &bi[4]},
	};
	vkUpdateDescriptorSets(c.dev, 2, w, 0, NULL);
	/* run 1: copied from set 0, the same spill-over on both sides */
	VkCopyDescriptorSet cp[2] = {
		{.sType = VK_STRUCTURE_TYPE_COPY_DESCRIPTOR_SET, .srcSet = sets[0], .srcBinding = 0, .dstSet = sets[1], .dstBinding = 0, .descriptorCount = 4},
		{.sType = VK_STRUCTURE_TYPE_COPY_DESCRIPTOR_SET, .srcSet = sets[0], .srcBinding = 4, .dstSet = sets[1], .dstBinding = 4, .descriptorCount = 1},
	};
	vkUpdateDescriptorSets(c.dev, 0, NULL, 2, cp);
	/* run 2: a descriptor update template with the same spilling entry */
	VkDescriptorUpdateTemplateEntry te[2] = {
		{0, 0, 4, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 0, sizeof(VkDescriptorBufferInfo)},
		{4, 0, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, 4 * sizeof(VkDescriptorBufferInfo), sizeof(VkDescriptorBufferInfo)},
	};
	VkDescriptorUpdateTemplateCreateInfo tci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_UPDATE_TEMPLATE_CREATE_INFO,
		.descriptorUpdateEntryCount = 2, .pDescriptorUpdateEntries = te,
		.templateType = VK_DESCRIPTOR_UPDATE_TEMPLATE_TYPE_DESCRIPTOR_SET, .descriptorSetLayout = dsl};
	PFN_vkCreateDescriptorUpdateTemplate create_tpl = (PFN_vkCreateDescriptorUpdateTemplate)vkGetDeviceProcAddr(c.dev, "vkCreateDescriptorUpdateTemplate");
	PFN_vkUpdateDescriptorSetWithTemplate update_tpl = (PFN_vkUpdateDescriptorSetWithTemplate)vkGetDeviceProcAddr(c.dev, "vkUpdateDescriptorSetWithTemplate");
	PFN_vkDestroyDescriptorUpdateTemplate destroy_tpl = (PFN_vkDestroyDescriptorUpdateTemplate)vkGetDeviceProcAddr(c.dev, "vkDestroyDescriptorUpdateTemplate");
	if (!create_tpl || !update_tpl || !destroy_tpl) {
		fprintf(stderr, "no descriptor update templates\n");
		return 1;
	}
	VkDescriptorUpdateTemplate tpl;
	CHECK(create_tpl(c.dev, &tci, NULL, &tpl));
	update_tpl(c.dev, sets[2], tpl, bi);

	VkCommandPool pool;
	VkCommandPoolCreateInfo pci = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .queueFamilyIndex = 0};
	CHECK(vkCreateCommandPool(c.dev, &pci, NULL, &pool));
	VkCommandBufferAllocateInfo cai = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = pool,
		.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
	VkCommandBuffer cb;
	CHECK(vkAllocateCommandBuffers(c.dev, &cai, &cb));
	VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
	VkFence fence;
	CHECK(vkCreateFence(c.dev, &fci, NULL, &fence));

	static const char *how[3] = {"write", "copy", "template"};
	for (uint32_t run = 0; run < 3; run++) {
		uint32_t k = 2 + 3 * run, pc[2] = {k, N}, doff = (uint32_t)(run * stride);
		VkCommandBufferBeginInfo bgi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
		CHECK(vkBeginCommandBuffer(cb, &bgi));
		vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipe);
		vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pl, 0, 1, &sets[run], 1, &doff);
		vkCmdPushConstants(cb, pl, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, pc);
		vkCmdDispatch(cb, N / 64, 1, 1);
		CHECK(vkEndCommandBuffer(cb));
		VkSubmitInfo si = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cb};
		CHECK(vkQueueSubmit(c.queue, 1, &si, fence));
		/* while the GPU works: words it does not touch (one inside a0's
		 * bound range, one in a dynamic region another run binds) */
		a0.p[N + 3] = 0xc0ffee00u + run;
		dyn.p[(run + 1) % 3 * stride / 4 + N] = 0xd00d0000u + run;
		CHECK(vkWaitForFences(c.dev, 1, &fence, VK_TRUE, UINT64_MAX));
		CHECK(vkResetFences(c.dev, 1, &fence));

		int before = bad;
		const uint32_t *d = dyn.p + doff / 4;
		for (uint32_t i = 0; i < N; i++) {
			uint32_t s = (i + 1) * k;
			expect("arr[0]", i, a0.p[i], s);
			expect("arr[1]", i, a1.p[i], s + 1);
			expect("out3", i, o3.p[LEAD + i], s + 2);
			expect("dyn", i, d[i], s + 3);
		}
		expect("a0 (CPU-written during the dispatch)", N + 3, a0.p[N + 3], 0xc0ffee00u + run);
		expect("dyn (CPU-written, outside the bound range)", N, dyn.p[(run + 1) % 3 * stride / 4 + N], 0xd00d0000u + run);
		for (uint32_t i = 0; i < LEAD; i++)
			expect("o3 (before the bound range)", i, o3.p[i], 0xa0000000u + i);
		printf("vk-sets: %s: %s\n", how[run], bad == before ? "ok" : "FAIL");
	}

	destroy_tpl(c.dev, tpl, NULL);
	vkDestroyFence(c.dev, fence, NULL);
	vkDestroyCommandPool(c.dev, pool, NULL);
	vkDestroyDescriptorPool(c.dev, dp, NULL);
	vkDestroyPipeline(c.dev, pipe, NULL);
	vkDestroyPipelineLayout(c.dev, pl, NULL);
	vkDestroyDescriptorSetLayout(c.dev, dsl, NULL);
	struct buf *all[5] = {&src, &a0, &a1, &o3, &dyn};
	for (int i = 0; i < 5; i++) {
		vkUnmapMemory(c.dev, all[i]->m);
		vkDestroyBuffer(c.dev, all[i]->b, NULL);
		vkFreeMemory(c.dev, all[i]->m, NULL);
	}
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
	printf("vk-sets: %s (%d wrong)\n", bad ? "FAIL" : "ok", bad);
	return bad ? 1 : 0;
}
