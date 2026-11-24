// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk threading test: three threads record and submit compute work (each
// its own buffer, pool and fence, waited with finite timeouts) while a
// fourth acquires and presents on a headless swapchain. The queue is
// externally synchronized, as Vulkan requires; everything else runs
// concurrently in the ICD. Exit 0 when every result is right.
#include <pthread.h>

#include "vk-common.h"

#include "double_comp.h"

#define N 1024
#define ROUNDS 15
#define WORKERS 3

static struct ctx c;
static pthread_mutex_t qmu = PTHREAD_MUTEX_INITIALIZER;
static VkPipeline pipe;
static VkPipelineLayout pl;
static VkDescriptorSetLayout dsl;
static VkSwapchainKHR swapchain;
static int failures;

static void submit_locked(VkCommandBuffer cb, VkFence f)
{
	VkSubmitInfo si = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cb};
	pthread_mutex_lock(&qmu);
	CHECK(vkQueueSubmit(c.queue, 1, &si, f));
	pthread_mutex_unlock(&qmu);
}

static void wait_fence(VkFence f)
{
	VkResult r;
	int spins = 0;
	while ((r = vkWaitForFences(c.dev, 1, &f, VK_TRUE, 2000000 /* 2 ms */)) == VK_TIMEOUT)
		if (++spins > 30000) {
			fprintf(stderr, "fence never signaled\n");
			exit(1);
		}
	CHECK(r);
}

static void *worker(void *arg)
{
	int id = (int)(intptr_t)arg;
	VkBuffer buf;
	VkDeviceMemory mem;
	host_buffer(&c, N * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, &buf, &mem);
	uint32_t *p;
	CHECK(vkMapMemory(c.dev, mem, 0, VK_WHOLE_SIZE, 0, (void **)&p));
	VkDescriptorPoolSize ps = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1};
	VkDescriptorPoolCreateInfo dpci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 1, .pPoolSizes = &ps};
	VkDescriptorPool dp;
	CHECK(vkCreateDescriptorPool(c.dev, &dpci, NULL, &dp));
	VkDescriptorSetAllocateInfo dsai = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dp,
		.descriptorSetCount = 1, .pSetLayouts = &dsl};
	VkDescriptorSet ds;
	CHECK(vkAllocateDescriptorSets(c.dev, &dsai, &ds));
	VkDescriptorBufferInfo bi = {buf, 0, VK_WHOLE_SIZE};
	VkWriteDescriptorSet w = {.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = ds, .descriptorCount = 1,
		.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi};
	vkUpdateDescriptorSets(c.dev, 1, &w, 0, NULL);
	VkCommandPool pool;
	VkCommandBuffer cb = begin_cmds(&c, &pool);
	CHECK(vkEndCommandBuffer(cb));
	VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
	VkFence f;
	CHECK(vkCreateFence(c.dev, &fci, NULL, &f));
	for (int round = 0; round < ROUNDS; round++) {
		for (uint32_t i = 0; i < N; i++)
			p[i] = i + (uint32_t)id * 100000 + (uint32_t)round;
		VkCommandBufferBeginInfo cbi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
		CHECK(vkBeginCommandBuffer(cb, &cbi));
		vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipe);
		vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pl, 0, 1, &ds, 0, NULL);
		vkCmdDispatch(cb, N / 64, 1, 1);
		CHECK(vkEndCommandBuffer(cb));
		CHECK(vkResetFences(c.dev, 1, &f));
		submit_locked(cb, f);
		wait_fence(f);
		for (uint32_t i = 0; i < N; i++)
			if (p[i] != 2 * (i + (uint32_t)id * 100000 + (uint32_t)round)) {
				fprintf(stderr, "worker %d round %d: v[%u] = %u\n", id, round, i, p[i]);
				__atomic_add_fetch(&failures, 1, __ATOMIC_RELAXED);
				break;
			}
	}
	vkDestroyFence(c.dev, f, NULL);
	vkDestroyCommandPool(c.dev, pool, NULL);
	vkDestroyDescriptorPool(c.dev, dp, NULL);
	vkUnmapMemory(c.dev, mem);
	vkDestroyBuffer(c.dev, buf, NULL);
	vkFreeMemory(c.dev, mem, NULL);
	return NULL;
}

static void *presenter(void *arg)
{
	(void)arg;
	VkImage imgs[8];
	uint32_t n = 8;
	CHECK(vkGetSwapchainImagesKHR(c.dev, swapchain, &n, imgs));
	VkCommandPool pool;
	VkCommandBuffer cb = begin_cmds(&c, &pool);
	CHECK(vkEndCommandBuffer(cb));
	VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
	VkFence f;
	CHECK(vkCreateFence(c.dev, &fci, NULL, &f));
	for (int frame = 0; frame < ROUNDS * 2; frame++) {
		uint32_t idx;
		CHECK(vkAcquireNextImageKHR(c.dev, swapchain, UINT64_MAX, VK_NULL_HANDLE, VK_NULL_HANDLE, &idx));
		VkCommandBufferBeginInfo cbi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
		CHECK(vkBeginCommandBuffer(cb, &cbi));
		VkClearColorValue col = {.float32 = {frame / 30.0f, 0, 1, 1}};
		VkImageSubresourceRange range = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
		vkCmdClearColorImage(cb, imgs[idx], VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &col, 1, &range);
		CHECK(vkEndCommandBuffer(cb));
		CHECK(vkResetFences(c.dev, 1, &f));
		submit_locked(cb, f);
		VkPresentInfoKHR pi = {.sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR, .swapchainCount = 1, .pSwapchains = &swapchain, .pImageIndices = &idx};
		pthread_mutex_lock(&qmu);
		CHECK(vkQueuePresentKHR(c.queue, &pi));
		pthread_mutex_unlock(&qmu);
		wait_fence(f);
	}
	vkDestroyFence(c.dev, f, NULL);
	vkDestroyCommandPool(c.dev, pool, NULL);
	return NULL;
}

int main(void)
{
	const char *iext[] = {VK_KHR_SURFACE_EXTENSION_NAME, VK_EXT_HEADLESS_SURFACE_EXTENSION_NAME};
	VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = "vk-threads", .apiVersion = VK_API_VERSION_1_0};
	VkInstanceCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app, .enabledExtensionCount = 2,
		.ppEnabledExtensionNames = iext};
	CHECK(vkCreateInstance(&ici, NULL, &c.inst));
	uint32_t n = 1;
	VkResult r = vkEnumeratePhysicalDevices(c.inst, &n, &c.pd);
	if ((r != VK_SUCCESS && r != VK_INCOMPLETE) || !n)
		return 1;
	vkGetPhysicalDeviceMemoryProperties(c.pd, &c.mem);
	float prio = 1;
	const char *dext[] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
	VkDeviceQueueCreateInfo q = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueCount = 1, .pQueuePriorities = &prio};
	VkDeviceCreateInfo dci = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1, .pQueueCreateInfos = &q,
		.enabledExtensionCount = 1, .ppEnabledExtensionNames = dext};
	CHECK(vkCreateDevice(c.pd, &dci, NULL, &c.dev));
	vkGetDeviceQueue(c.dev, 0, 0, &c.queue);

	VkDescriptorSetLayoutBinding b = {.binding = 0, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .descriptorCount = 1,
		.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT};
	VkDescriptorSetLayoutCreateInfo lci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &b};
	CHECK(vkCreateDescriptorSetLayout(c.dev, &lci, NULL, &dsl));
	VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &dsl};
	CHECK(vkCreatePipelineLayout(c.dev, &plci, NULL, &pl));
	VkComputePipelineCreateInfo cpci = {.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
		.stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
			.module = shader(&c, spv_double_comp, sizeof spv_double_comp), .pName = "main"},
		.layout = pl};
	CHECK(vkCreateComputePipelines(c.dev, VK_NULL_HANDLE, 1, &cpci, NULL, &pipe));

	PFN_vkCreateHeadlessSurfaceEXT create_headless = (PFN_vkCreateHeadlessSurfaceEXT)vkGetInstanceProcAddr(c.inst, "vkCreateHeadlessSurfaceEXT");
	VkHeadlessSurfaceCreateInfoEXT hci = {.sType = VK_STRUCTURE_TYPE_HEADLESS_SURFACE_CREATE_INFO_EXT};
	VkSurfaceKHR surf;
	CHECK(create_headless(c.inst, &hci, NULL, &surf));
	VkSwapchainCreateInfoKHR sci = {.sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR, .surface = surf, .minImageCount = 2,
		.imageFormat = VK_FORMAT_B8G8R8A8_UNORM, .imageColorSpace = VK_COLOR_SPACE_SRGB_NONLINEAR_KHR, .imageExtent = {64, 64},
		.imageArrayLayers = 1, .imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
		.preTransform = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR, .compositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR,
		.presentMode = VK_PRESENT_MODE_FIFO_KHR, .clipped = VK_TRUE};
	CHECK(vkCreateSwapchainKHR(c.dev, &sci, NULL, &swapchain));

	pthread_t th[WORKERS + 1];
	for (int i = 0; i < WORKERS; i++)
		pthread_create(&th[i], NULL, worker, (void *)(intptr_t)i);
	pthread_create(&th[WORKERS], NULL, presenter, NULL);
	for (int i = 0; i <= WORKERS; i++)
		pthread_join(th[i], NULL);

	CHECK(vkDeviceWaitIdle(c.dev));
	vkDestroySwapchainKHR(c.dev, swapchain, NULL);
	vkDestroySurfaceKHR(c.inst, surf, NULL);
	vkDestroyPipeline(c.dev, pipe, NULL);
	vkDestroyPipelineLayout(c.dev, pl, NULL);
	vkDestroyDescriptorSetLayout(c.dev, dsl, NULL);
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
	printf("vk-threads: %s (%d workers x %d rounds, %d presents)\n", failures ? "FAIL" : "ok", WORKERS, ROUNDS, ROUNDS * 2);
	return failures ? 1 : 0;
}
