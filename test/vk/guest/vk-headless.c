// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk swapchain test on VK_EXT_headless_surface: for a few frames,
// acquire, clear the image to a per-frame colour, copy it to a buffer,
// present, and check the buffer. Exit 0 on success.
#include "vk-common.h"

#define W 32
#define H 32

int main(void)
{
	struct ctx c;
	const char *iext[] = {VK_KHR_SURFACE_EXTENSION_NAME, VK_EXT_HEADLESS_SURFACE_EXTENSION_NAME};
	VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = "vk-headless", .apiVersion = VK_API_VERSION_1_0};
	VkInstanceCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app, .enabledExtensionCount = 2,
		.ppEnabledExtensionNames = iext};
	CHECK(vkCreateInstance(&ici, NULL, &c.inst));
	uint32_t n = 1;
	VkResult r = vkEnumeratePhysicalDevices(c.inst, &n, &c.pd);
	if ((r != VK_SUCCESS && r != VK_INCOMPLETE) || !n)
		return 1;
	vkGetPhysicalDeviceMemoryProperties(c.pd, &c.mem);
	PFN_vkCreateHeadlessSurfaceEXT create_headless = (PFN_vkCreateHeadlessSurfaceEXT)vkGetInstanceProcAddr(c.inst, "vkCreateHeadlessSurfaceEXT");
	VkHeadlessSurfaceCreateInfoEXT hci = {.sType = VK_STRUCTURE_TYPE_HEADLESS_SURFACE_CREATE_INFO_EXT};
	VkSurfaceKHR surf;
	CHECK(create_headless(c.inst, &hci, NULL, &surf));
	VkBool32 ok = 0;
	CHECK(vkGetPhysicalDeviceSurfaceSupportKHR(c.pd, 0, surf, &ok));
	if (!ok) {
		fprintf(stderr, "headless surface not supported\n");
		return 1;
	}
	float prio = 1;
	const char *dext[] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
	VkDeviceQueueCreateInfo q = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueCount = 1, .pQueuePriorities = &prio};
	VkDeviceCreateInfo dci = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1, .pQueueCreateInfos = &q,
		.enabledExtensionCount = 1, .ppEnabledExtensionNames = dext};
	CHECK(vkCreateDevice(c.pd, &dci, NULL, &c.dev));
	vkGetDeviceQueue(c.dev, 0, 0, &c.queue);

	VkSwapchainCreateInfoKHR sci = {.sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR, .surface = surf, .minImageCount = 3,
		.imageFormat = VK_FORMAT_B8G8R8A8_UNORM, .imageColorSpace = VK_COLOR_SPACE_SRGB_NONLINEAR_KHR, .imageExtent = {W, H},
		.imageArrayLayers = 1, .imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
		.preTransform = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR, .compositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR,
		.presentMode = VK_PRESENT_MODE_FIFO_KHR, .clipped = VK_TRUE};
	VkSwapchainKHR sc;
	CHECK(vkCreateSwapchainKHR(c.dev, &sci, NULL, &sc));
	uint32_t nimg = 0;
	CHECK(vkGetSwapchainImagesKHR(c.dev, sc, &nimg, NULL));
	VkImage imgs[8];
	if (nimg > 8)
		nimg = 8;
	CHECK(vkGetSwapchainImagesKHR(c.dev, sc, &nimg, imgs));

	VkBuffer buf;
	VkDeviceMemory mem;
	host_buffer(&c, W * H * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, &buf, &mem);
	uint8_t *p;
	CHECK(vkMapMemory(c.dev, mem, 0, VK_WHOLE_SIZE, 0, (void **)&p));
	VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
	VkFence fence;
	CHECK(vkCreateFence(c.dev, &fci, NULL, &fence));
	VkCommandPool pool;
	VkCommandBuffer cb = begin_cmds(&c, &pool);
	CHECK(vkEndCommandBuffer(cb));
	int bad = 0;
	for (int frame = 0; frame < 6; frame++) {
		uint32_t idx;
		CHECK(vkAcquireNextImageKHR(c.dev, sc, UINT64_MAX, VK_NULL_HANDLE, VK_NULL_HANDLE, &idx));
		VkCommandBufferBeginInfo bi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
		CHECK(vkBeginCommandBuffer(cb, &bi));
		VkClearColorValue col = {.float32 = {frame / 5.0f, 1.0f - frame / 5.0f, 0.5f, 1}};
		VkImageSubresourceRange range = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
		vkCmdClearColorImage(cb, imgs[idx], VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &col, 1, &range);
		VkBufferImageCopy region = {.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1}, .imageExtent = {W, H, 1}};
		vkCmdCopyImageToBuffer(cb, imgs[idx], VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buf, 1, &region);
		CHECK(vkEndCommandBuffer(cb));
		VkSubmitInfo si = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cb};
		CHECK(vkResetFences(c.dev, 1, &fence));
		CHECK(vkQueueSubmit(c.queue, 1, &si, fence));
		VkPresentInfoKHR pi = {.sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR, .swapchainCount = 1, .pSwapchains = &sc, .pImageIndices = &idx};
		CHECK(vkQueuePresentKHR(c.queue, &pi));
		CHECK(vkWaitForFences(c.dev, 1, &fence, VK_TRUE, UINT64_MAX));
		/* BGRA */
		int want_r = (int)(frame / 5.0f * 255 + 0.5f), want_g = 255 - want_r;
		const uint8_t *px = p + ((H / 2) * W + W / 2) * 4;
		int okp = abs(px[2] - want_r) <= 2 && abs(px[1] - want_g) <= 2 && abs(px[0] - 128) <= 2 && px[3] == 255;
		printf("  frame %d image %u: %02x%02x%02x%02x (BGRA) %s\n", frame, idx, px[0], px[1], px[2], px[3], okp ? "ok" : "WRONG");
		bad += !okp;
	}
	CHECK(vkDeviceWaitIdle(c.dev));
	vkUnmapMemory(c.dev, mem);
	vkDestroyFence(c.dev, fence, NULL);
	vkDestroyCommandPool(c.dev, pool, NULL);
	vkDestroyBuffer(c.dev, buf, NULL);
	vkFreeMemory(c.dev, mem, NULL);
	vkDestroySwapchainKHR(c.dev, sc, NULL);
	vkDestroySurfaceKHR(c.inst, surf, NULL);
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
	printf("vk-headless: %s\n", bad ? "FAIL" : "ok");
	return bad ? 1 : 0;
}
