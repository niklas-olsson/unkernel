// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk test of the round-2 paths: the triangle of vk-triangle drawn with
// VK_KHR_dynamic_rendering (no render pass), viewport, scissor and cull
// mode as dynamic state (VK_EXT_extended_dynamic_state) and a negative
// viewport height (VK_KHR_maintenance1), which flips it upside down.
// Checks pixels that tell the flip apart. Exit 0 on success.
#include "vk-common.h"

#include "triangle_frag.h"
#include "triangle_vert.h"

#define W 64
#define H 64

int main(void)
{
	struct ctx c;
	VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = "vk-dynamic", .apiVersion = VK_API_VERSION_1_1};
	VkInstanceCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app};
	CHECK(vkCreateInstance(&ici, NULL, &c.inst));
	uint32_t n = 1;
	VkResult r = vkEnumeratePhysicalDevices(c.inst, &n, &c.pd);
	if ((r != VK_SUCCESS && r != VK_INCOMPLETE) || !n)
		return 1;
	vkGetPhysicalDeviceMemoryProperties(c.pd, &c.mem);
	VkPhysicalDeviceExtendedDynamicStateFeaturesEXT eds = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTENDED_DYNAMIC_STATE_FEATURES_EXT};
	VkPhysicalDeviceDynamicRenderingFeatures dr = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DYNAMIC_RENDERING_FEATURES, .pNext = &eds};
	VkPhysicalDeviceFeatures2 f2 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &dr};
	vkGetPhysicalDeviceFeatures2(c.pd, &f2);
	if (!dr.dynamicRendering || !eds.extendedDynamicState) {
		fprintf(stderr, "vk-dynamic: features missing (dynamicRendering %u, extendedDynamicState %u)\n", dr.dynamicRendering,
			eds.extendedDynamicState);
		return 1;
	}
	float prio = 1;
	const char *dext[] = {VK_KHR_MAINTENANCE_1_EXTENSION_NAME, VK_KHR_CREATE_RENDERPASS_2_EXTENSION_NAME,
		VK_KHR_DEPTH_STENCIL_RESOLVE_EXTENSION_NAME, VK_KHR_DYNAMIC_RENDERING_EXTENSION_NAME, VK_EXT_EXTENDED_DYNAMIC_STATE_EXTENSION_NAME};
	VkDeviceQueueCreateInfo q = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueCount = 1, .pQueuePriorities = &prio};
	VkDeviceCreateInfo dci = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .pNext = &f2, .queueCreateInfoCount = 1, .pQueueCreateInfos = &q,
		.enabledExtensionCount = 5, .ppEnabledExtensionNames = dext};
	CHECK(vkCreateDevice(c.pd, &dci, NULL, &c.dev));
	vkGetDeviceQueue(c.dev, 0, 0, &c.queue);
	PFN_vkCmdBeginRenderingKHR begin_rendering = (PFN_vkCmdBeginRenderingKHR)vkGetDeviceProcAddr(c.dev, "vkCmdBeginRenderingKHR");
	PFN_vkCmdEndRenderingKHR end_rendering = (PFN_vkCmdEndRenderingKHR)vkGetDeviceProcAddr(c.dev, "vkCmdEndRenderingKHR");
	PFN_vkCmdSetCullModeEXT set_cull = (PFN_vkCmdSetCullModeEXT)vkGetDeviceProcAddr(c.dev, "vkCmdSetCullModeEXT");
	if (!begin_rendering || !end_rendering || !set_cull) {
		fprintf(stderr, "vk-dynamic: entry points missing\n");
		return 1;
	}

	VkFormat fmt = VK_FORMAT_R8G8B8A8_UNORM;
	VkImageCreateInfo imci = {.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = fmt,
		.extent = {W, H, 1}, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
		.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT};
	VkImage img;
	CHECK(vkCreateImage(c.dev, &imci, NULL, &img));
	VkMemoryRequirements req;
	vkGetImageMemoryRequirements(c.dev, img, &req);
	VkMemoryAllocateInfo mai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
		.memoryTypeIndex = mem_type(&c, req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)};
	VkDeviceMemory imem;
	CHECK(vkAllocateMemory(c.dev, &mai, NULL, &imem));
	CHECK(vkBindImageMemory(c.dev, img, imem, 0));
	VkImageViewCreateInfo vci = {.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img, .viewType = VK_IMAGE_VIEW_TYPE_2D,
		.format = fmt, .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
	VkImageView view;
	CHECK(vkCreateImageView(c.dev, &vci, NULL, &view));

	VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
	VkPipelineLayout pl;
	CHECK(vkCreatePipelineLayout(c.dev, &plci, NULL, &pl));
	VkPipelineShaderStageCreateInfo stages[2] = {
		{.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT,
			.module = shader(&c, spv_triangle_vert, sizeof spv_triangle_vert), .pName = "main"},
		{.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
			.module = shader(&c, spv_triangle_frag, sizeof spv_triangle_frag), .pName = "main"},
	};
	VkPipelineVertexInputStateCreateInfo vis = {.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
	VkPipelineInputAssemblyStateCreateInfo ias = {.sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
		.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST};
	VkPipelineViewportStateCreateInfo vps = {.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1, .scissorCount = 1};
	/* the flip makes the clockwise triangle counter-clockwise, i.e. front-facing
	 * here: the static cull mode (front) would cull it, the dynamic one (back)
	 * keeps it, as long as the flip and the cull mode are both honoured */
	VkPipelineRasterizationStateCreateInfo rs = {.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
		.polygonMode = VK_POLYGON_MODE_FILL, .cullMode = VK_CULL_MODE_FRONT_BIT, .frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE,
		.lineWidth = 1};
	VkPipelineMultisampleStateCreateInfo ms = {.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
		.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT};
	VkPipelineColorBlendAttachmentState cba = {.colorWriteMask = 0xf};
	VkPipelineColorBlendStateCreateInfo cbs = {.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, .attachmentCount = 1,
		.pAttachments = &cba};
	VkDynamicState dyn[] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR, VK_DYNAMIC_STATE_CULL_MODE_EXT};
	VkPipelineDynamicStateCreateInfo ds = {.sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO, .dynamicStateCount = 3, .pDynamicStates = dyn};
	VkPipelineRenderingCreateInfo prci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO, .colorAttachmentCount = 1,
		.pColorAttachmentFormats = &fmt};
	VkGraphicsPipelineCreateInfo gpci = {.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .pNext = &prci, .stageCount = 2,
		.pStages = stages, .pVertexInputState = &vis, .pInputAssemblyState = &ias, .pViewportState = &vps, .pRasterizationState = &rs,
		.pMultisampleState = &ms, .pColorBlendState = &cbs, .pDynamicState = &ds, .layout = pl};
	VkPipeline pipe;
	CHECK(vkCreateGraphicsPipelines(c.dev, VK_NULL_HANDLE, 1, &gpci, NULL, &pipe));

	VkBuffer buf;
	VkDeviceMemory bmem;
	host_buffer(&c, W * H * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, &buf, &bmem);
	VkCommandPool pool;
	VkCommandBuffer cb = begin_cmds(&c, &pool);
	VkImageMemoryBarrier toatt = {.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
		.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED, .newLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .image = img,
		.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
	vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, 0, 0, NULL, 0, NULL, 1, &toatt);
	VkRenderingAttachmentInfo att = {.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = view,
		.imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
		.clearValue = {.color = {.float32 = {0, 0, 1, 1}}}};
	VkRenderingInfo ri = {.sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = {{0, 0}, {W, H}}, .layerCount = 1,
		.colorAttachmentCount = 1, .pColorAttachments = &att};
	begin_rendering(cb, &ri);
	vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
	VkViewport vp = {0, H, W, -(float)H, 0, 1}; /* flipped */
	VkRect2D sc = {{0, 0}, {W, H}};
	vkCmdSetViewport(cb, 0, 1, &vp);
	vkCmdSetScissor(cb, 0, 1, &sc);
	set_cull(cb, VK_CULL_MODE_BACK_BIT);
	vkCmdDraw(cb, 3, 1, 0, 0);
	end_rendering(cb);
	VkBufferImageCopy region = {.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1}, .imageExtent = {W, H, 1}};
	vkCmdCopyImageToBuffer(cb, img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buf, 1, &region);
	submit_wait(&c, cb);

	uint8_t *p;
	CHECK(vkMapMemory(c.dev, bmem, 0, VK_WHOLE_SIZE, 0, (void **)&p));
	/* vk-triangle's probes mirrored vertically */
	static const struct {
		int x, y, red;
	} probe[] = {{32, 31, 1}, {1, 62, 0}, {62, 1, 0}, {44, 17, 1}, {44, 46, 0}, {32, 43, 1}};
	int bad = 0;
	for (size_t i = 0; i < sizeof probe / sizeof *probe; i++) {
		const uint8_t *px = p + (probe[i].y * W + probe[i].x) * 4;
		int want_r = probe[i].red ? 255 : 0, want_b = probe[i].red ? 0 : 255;
		int ok = abs(px[0] - want_r) < 3 && px[1] < 3 && abs(px[2] - want_b) < 3 && px[3] > 252;
		printf("  (%d,%d) = %02x%02x%02x%02x want %s %s\n", probe[i].x, probe[i].y, px[0], px[1], px[2], px[3],
		       probe[i].red ? "red" : "blue", ok ? "ok" : "WRONG");
		bad += !ok;
	}
	vkUnmapMemory(c.dev, bmem);
	CHECK(vkDeviceWaitIdle(c.dev));
	vkDestroyCommandPool(c.dev, pool, NULL);
	vkDestroyPipeline(c.dev, pipe, NULL);
	vkDestroyPipelineLayout(c.dev, pl, NULL);
	vkDestroyImageView(c.dev, view, NULL);
	vkDestroyImage(c.dev, img, NULL);
	vkFreeMemory(c.dev, imem, NULL);
	vkDestroyBuffer(c.dev, buf, NULL);
	vkFreeMemory(c.dev, bmem, NULL);
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
	printf("vk-dynamic: %s\n", bad ? "FAIL" : "ok");
	return bad ? 1 : 0;
}
