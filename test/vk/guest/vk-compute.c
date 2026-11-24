// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk compute test: a storage buffer of N uints doubled by a compute
// shader (double.comp), read back through mapped memory. Exit 0 on success.
#include "vk-common.h"

#include "double_comp.h"

#define N 4096

int main(void)
{
	struct ctx c;
	ctx_init(&c, "vk-compute");
	VkBuffer buf;
	VkDeviceMemory mem;
	host_buffer(&c, N * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, &buf, &mem);
	uint32_t *p;
	CHECK(vkMapMemory(c.dev, mem, 0, VK_WHOLE_SIZE, 0, (void **)&p));
	for (uint32_t i = 0; i < N; i++)
		p[i] = i + 1;

	VkDescriptorSetLayoutBinding b = {.binding = 0, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .descriptorCount = 1,
		.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT};
	VkDescriptorSetLayoutCreateInfo lci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &b};
	VkDescriptorSetLayout dsl;
	CHECK(vkCreateDescriptorSetLayout(c.dev, &lci, NULL, &dsl));
	VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &dsl};
	VkPipelineLayout pl;
	CHECK(vkCreatePipelineLayout(c.dev, &plci, NULL, &pl));
	VkComputePipelineCreateInfo cpci = {.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
		.stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
			.module = shader(&c, spv_double_comp, sizeof spv_double_comp), .pName = "main"},
		.layout = pl};
	VkPipeline pipe;
	CHECK(vkCreateComputePipelines(c.dev, VK_NULL_HANDLE, 1, &cpci, NULL, &pipe));

	VkDescriptorPoolSize ps = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1};
	VkDescriptorPoolCreateInfo dpci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 1, .pPoolSizes = &ps};
	VkDescriptorPool dp;
	CHECK(vkCreateDescriptorPool(c.dev, &dpci, NULL, &dp));
	VkDescriptorSetAllocateInfo dsai = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dp,
		.descriptorSetCount = 1, .pSetLayouts = &dsl};
	VkDescriptorSet ds;
	CHECK(vkAllocateDescriptorSets(c.dev, &dsai, &ds));
	VkDescriptorBufferInfo bi = {buf, 0, VK_WHOLE_SIZE};
	VkWriteDescriptorSet w = {.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = ds, .dstBinding = 0, .descriptorCount = 1,
		.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi};
	vkUpdateDescriptorSets(c.dev, 1, &w, 0, NULL);

	VkCommandPool pool;
	VkCommandBuffer cb = begin_cmds(&c, &pool);
	vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipe);
	vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pl, 0, 1, &ds, 0, NULL);
	vkCmdDispatch(cb, N / 64, 1, 1);
	submit_wait(&c, cb);
	VkMappedMemoryRange r = {.sType = VK_STRUCTURE_TYPE_MAPPED_MEMORY_RANGE, .memory = mem, .size = VK_WHOLE_SIZE};
	CHECK(vkInvalidateMappedMemoryRanges(c.dev, 1, &r));

	int bad = 0;
	for (uint32_t i = 0; i < N; i++)
		if (p[i] != 2 * (i + 1)) {
			if (bad < 5)
				fprintf(stderr, "v[%u] = %u, want %u\n", i, p[i], 2 * (i + 1));
			bad++;
		}
	vkUnmapMemory(c.dev, mem);
	vkDestroyCommandPool(c.dev, pool, NULL);
	vkDestroyDescriptorPool(c.dev, dp, NULL);
	vkDestroyPipeline(c.dev, pipe, NULL);
	vkDestroyPipelineLayout(c.dev, pl, NULL);
	vkDestroyDescriptorSetLayout(c.dev, dsl, NULL);
	vkDestroyBuffer(c.dev, buf, NULL);
	vkFreeMemory(c.dev, mem, NULL);
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
	printf("vk-compute: %s (%d of %d wrong)\n", bad ? "FAIL" : "ok", bad, N);
	return bad ? 1 : 0;
}
