// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk headless render test: a red triangle on blue in a 64x64 RGBA8
// image, copied to a buffer and checked at a few pixels, including two
// that tell an upside-down image apart. Exit 0 on success.
#include "vk-common.h"

#include "triangle_frag.h"
#include "triangle_vert.h"

#define W 64
#define H 64

int main(void)
{
	struct ctx c;
	ctx_init(&c, "vk-triangle");
	VkFormat fmt = VK_FORMAT_R8G8B8A8_UNORM;
	VkImageCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = fmt,
		.extent = {W, H, 1}, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
		.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT};
	VkImage img;
	CHECK(vkCreateImage(c.dev, &ici, NULL, &img));
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

	VkAttachmentDescription att = {.format = fmt, .samples = VK_SAMPLE_COUNT_1_BIT, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
		.storeOp = VK_ATTACHMENT_STORE_OP_STORE, .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
		.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
		.finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL};
	VkAttachmentReference ref = {0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
	VkSubpassDescription sub = {.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1, .pColorAttachments = &ref};
	VkRenderPassCreateInfo rpci = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 1, .pAttachments = &att,
		.subpassCount = 1, .pSubpasses = &sub};
	VkRenderPass rp;
	CHECK(vkCreateRenderPass(c.dev, &rpci, NULL, &rp));
	VkFramebufferCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp, .attachmentCount = 1,
		.pAttachments = &view, .width = W, .height = H, .layers = 1};
	VkFramebuffer fb;
	CHECK(vkCreateFramebuffer(c.dev, &fci, NULL, &fb));

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
	VkViewport vp = {0, 0, W, H, 0, 1};
	VkRect2D sc = {{0, 0}, {W, H}};
	VkPipelineViewportStateCreateInfo vps = {.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
		.pViewports = &vp, .scissorCount = 1, .pScissors = &sc};
	VkPipelineRasterizationStateCreateInfo rs = {.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
		.polygonMode = VK_POLYGON_MODE_FILL, .cullMode = VK_CULL_MODE_NONE, .frontFace = VK_FRONT_FACE_CLOCKWISE, .lineWidth = 1};
	VkPipelineMultisampleStateCreateInfo ms = {.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
		.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT};
	VkPipelineColorBlendAttachmentState cba = {.colorWriteMask = 0xf};
	VkPipelineColorBlendStateCreateInfo cbs = {.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, .attachmentCount = 1,
		.pAttachments = &cba};
	VkGraphicsPipelineCreateInfo gpci = {.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
		.pVertexInputState = &vis, .pInputAssemblyState = &ias, .pViewportState = &vps, .pRasterizationState = &rs,
		.pMultisampleState = &ms, .pColorBlendState = &cbs, .layout = pl, .renderPass = rp, .subpass = 0};
	VkPipeline pipe;
	CHECK(vkCreateGraphicsPipelines(c.dev, VK_NULL_HANDLE, 1, &gpci, NULL, &pipe));

	VkBuffer buf;
	VkDeviceMemory bmem;
	host_buffer(&c, W * H * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, &buf, &bmem);

	VkCommandPool pool;
	VkCommandBuffer cb = begin_cmds(&c, &pool);
	VkClearValue clear = {.color = {.float32 = {0, 0, 1, 1}}};
	VkRenderPassBeginInfo rpbi = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
		.renderArea = {{0, 0}, {W, H}}, .clearValueCount = 1, .pClearValues = &clear};
	vkCmdBeginRenderPass(cb, &rpbi, VK_SUBPASS_CONTENTS_INLINE);
	vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
	vkCmdDraw(cb, 3, 1, 0, 0);
	vkCmdEndRenderPass(cb);
	VkBufferImageCopy region = {.bufferOffset = 0, .imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1}, .imageExtent = {W, H, 1}};
	vkCmdCopyImageToBuffer(cb, img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buf, 1, &region);
	submit_wait(&c, cb);

	uint8_t *p;
	CHECK(vkMapMemory(c.dev, bmem, 0, VK_WHOLE_SIZE, 0, (void **)&p));
	static const struct {
		int x, y, red;
	} probe[] = {{32, 32, 1}, {1, 1, 0}, {62, 62, 0}, {44, 46, 1}, {44, 17, 0}, {32, 20, 1}};
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
	vkDestroyFramebuffer(c.dev, fb, NULL);
	vkDestroyRenderPass(c.dev, rp, NULL);
	vkDestroyImageView(c.dev, view, NULL);
	vkDestroyImage(c.dev, img, NULL);
	vkFreeMemory(c.dev, imem, NULL);
	vkDestroyBuffer(c.dev, buf, NULL);
	vkFreeMemory(c.dev, bmem, NULL);
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
	printf("vk-triangle: %s\n", bad ? "FAIL" : "ok");
	return bad ? 1 : 0;
}
