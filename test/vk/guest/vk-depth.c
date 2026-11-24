// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk depth and culling test: a near red triangle drawn before a far
// green one that overlaps it, with a D32 depth attachment cleared to 1 and
// LESS: the overlap must stay red; the green one winds the other way and
// is culled as back-facing. Drawn twice, with a normal and with a negative
// viewport height (VK_KHR_maintenance1), and with the depth cleared by a
// depth-only render pass of its own and loaded by the next (as vkd3d
// does), counting the passed samples with an occlusion query. Exit 0 on
// success.
#include "vk-common.h"

#include "depth_frag.h"
#include "depth_vert.h"

#define W 64
#define H 64

/* mode 0: one pass; 1: negative viewport; 2: the depth cleared by a depth-only render pass of its own, then loaded (vkd3d) */
static int run(struct ctx *cp, int mode)
{
	struct ctx c = *cp;
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

	VkImageCreateInfo dci = ici;
	dci.format = VK_FORMAT_D32_SFLOAT;
	dci.usage = VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT;
	VkImage dimg;
	CHECK(vkCreateImage(c.dev, &dci, NULL, &dimg));
	VkDeviceMemory dmem;
	CHECK(vkAllocateMemory(c.dev, &mai, NULL, &dmem));
	CHECK(vkBindImageMemory(c.dev, dimg, dmem, 0));
	VkImageViewCreateInfo dvci = vci;
	dvci.image = dimg;
	dvci.format = VK_FORMAT_D32_SFLOAT;
	dvci.subresourceRange.aspectMask = VK_IMAGE_ASPECT_DEPTH_BIT;
	VkImageView dview;
	CHECK(vkCreateImageView(c.dev, &dvci, NULL, &dview));
	VkAttachmentDescription att = {.format = fmt, .samples = VK_SAMPLE_COUNT_1_BIT, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
		.storeOp = VK_ATTACHMENT_STORE_OP_STORE, .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
		.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
		.finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL};
	VkAttachmentDescription datt = {.format = VK_FORMAT_D32_SFLOAT, .samples = VK_SAMPLE_COUNT_1_BIT, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
		.storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
		.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
		.finalLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
	if (mode == 2) {
		datt.loadOp = VK_ATTACHMENT_LOAD_OP_LOAD;
		datt.initialLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
	}
	VkAttachmentDescription catt = datt;
	catt.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
	catt.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
	catt.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
	VkAttachmentReference cref = {0, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
	VkSubpassDescription csub = {.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .pDepthStencilAttachment = &cref};
	VkRenderPassCreateInfo crpci = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 1, .pAttachments = &catt,
		.subpassCount = 1, .pSubpasses = &csub};
	VkRenderPass crp;
	CHECK(vkCreateRenderPass(c.dev, &crpci, NULL, &crp));
	VkFramebufferCreateInfo cfci = {.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = crp, .attachmentCount = 1,
		.pAttachments = &dview, .width = W, .height = H, .layers = 1};
	VkFramebuffer cfb;
	CHECK(vkCreateFramebuffer(c.dev, &cfci, NULL, &cfb));
	VkAttachmentDescription atts[2] = {att, datt};
	VkAttachmentReference ref = {0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
	VkAttachmentReference dref = {1, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
	VkSubpassDescription sub = {.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1, .pColorAttachments = &ref,
		.pDepthStencilAttachment = &dref};
	VkRenderPassCreateInfo rpci = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 2, .pAttachments = atts,
		.subpassCount = 1, .pSubpasses = &sub};
	VkRenderPass rp;
	CHECK(vkCreateRenderPass(c.dev, &rpci, NULL, &rp));
	VkImageView fbviews[2] = {view, dview};
	VkFramebufferCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp, .attachmentCount = 2,
		.pAttachments = fbviews, .width = W, .height = H, .layers = 1};
	VkFramebuffer fb;
	CHECK(vkCreateFramebuffer(c.dev, &fci, NULL, &fb));

	VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
	VkPipelineLayout pl;
	CHECK(vkCreatePipelineLayout(c.dev, &plci, NULL, &pl));
	VkPipelineShaderStageCreateInfo stages[2] = {
		{.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT,
			.module = shader(&c, spv_depth_vert, sizeof spv_depth_vert), .pName = "main"},
		{.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
			.module = shader(&c, spv_depth_frag, sizeof spv_depth_frag), .pName = "main"},
	};
	VkPipelineVertexInputStateCreateInfo vis = {.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
	VkPipelineInputAssemblyStateCreateInfo ias = {.sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
		.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST};
	VkViewport vp = mode == 1 ? (VkViewport){0, H, W, -(float)H, 0, 1} : (VkViewport){0, 0, W, H, 0, 1};
	VkRect2D sc = {{0, 0}, {W, H}};
	VkPipelineViewportStateCreateInfo vps = {.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
		.pViewports = &vp, .scissorCount = 1, .pScissors = &sc};
	VkPipelineRasterizationStateCreateInfo rs = {.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
		.polygonMode = VK_POLYGON_MODE_FILL, .cullMode = VK_CULL_MODE_BACK_BIT,
		/* the red triangle is clockwise in framebuffer space, counter-clockwise when flipped */
		.frontFace = mode == 1 ? VK_FRONT_FACE_COUNTER_CLOCKWISE : VK_FRONT_FACE_CLOCKWISE, .lineWidth = 1};
	VkPipelineMultisampleStateCreateInfo ms = {.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
		.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT};
	VkPipelineDepthStencilStateCreateInfo dss = {.sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO, .depthTestEnable = 1,
		.depthWriteEnable = 1, .depthCompareOp = VK_COMPARE_OP_LESS};
	VkPipelineColorBlendAttachmentState cba = {.colorWriteMask = 0xf};
	VkPipelineColorBlendStateCreateInfo cbs = {.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, .attachmentCount = 1,
		.pAttachments = &cba};
	VkGraphicsPipelineCreateInfo gpci = {.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
		.pVertexInputState = &vis, .pInputAssemblyState = &ias, .pViewportState = &vps, .pRasterizationState = &rs,
		.pMultisampleState = &ms, .pDepthStencilState = &dss, .pColorBlendState = &cbs, .layout = pl, .renderPass = rp, .subpass = 0};
	VkPipeline pipe;
	CHECK(vkCreateGraphicsPipelines(c.dev, VK_NULL_HANDLE, 1, &gpci, NULL, &pipe));

	VkBuffer buf;
	VkDeviceMemory bmem;
	host_buffer(&c, W * H * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, &buf, &bmem);

	VkCommandPool pool;
	VkCommandBuffer cb = begin_cmds(&c, &pool);
	VkClearValue clears[2] = {{.color = {.float32 = {0, 0, 1, 1}}}, {.depthStencil = {1.0f, 0}}};
	VkRenderPassBeginInfo rpbi = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
		.renderArea = {{0, 0}, {W, H}}, .clearValueCount = 2, .pClearValues = clears};
	VkQueryPoolCreateInfo qpci = {.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, .queryType = VK_QUERY_TYPE_OCCLUSION, .queryCount = 1};
	VkQueryPool qp;
	CHECK(vkCreateQueryPool(c.dev, &qpci, NULL, &qp));
	vkCmdResetQueryPool(cb, qp, 0, 1);
	if (mode == 2) {
		VkClearValue dclear = {.depthStencil = {1.0f, 0}};
		VkRenderPassBeginInfo cbi = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = crp, .framebuffer = cfb,
			.renderArea = {{0, 0}, {W, H}}, .clearValueCount = 1, .pClearValues = &dclear};
		vkCmdBeginRenderPass(cb, &cbi, VK_SUBPASS_CONTENTS_INLINE);
		vkCmdEndRenderPass(cb);
	}
	vkCmdBeginRenderPass(cb, &rpbi, VK_SUBPASS_CONTENTS_INLINE);
	vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
	vkCmdBeginQuery(cb, qp, 0, 0);
	vkCmdDraw(cb, 6, 1, 0, 0);
	vkCmdEndQuery(cb, qp, 0);
	vkCmdEndRenderPass(cb);
	VkBufferImageCopy region = {.bufferOffset = 0, .imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1}, .imageExtent = {W, H, 1}};
	vkCmdCopyImageToBuffer(cb, img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buf, 1, &region);
	submit_wait(&c, cb);

	uint64_t samples[2] = {0, 0};
	VkResult qr = vkGetQueryPoolResults(c.dev, qp, 0, 1, sizeof samples, samples, sizeof samples,
					    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT | VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
	int qbad = qr != VK_SUCCESS || !samples[0] || !samples[1];
	printf("  occlusion query: result %d, %llu samples passed, available %llu %s\n", qr, (unsigned long long)samples[0],
	       (unsigned long long)samples[1], qbad ? "WRONG" : "ok");
	vkDestroyQueryPool(c.dev, qp, NULL);
	uint8_t *p;
	CHECK(vkMapMemory(c.dev, bmem, 0, VK_WHOLE_SIZE, 0, (void **)&p));
	const struct {
		int x, y, red;
	} probe[] = {{32, 32, 1}, {32, 30, 1}, {1, 1, 0}, {10, mode == 1 ? 7 : 56, 0} /* green only, which is back-facing: culled */};
	int bad = qbad;
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
	vkDestroyFramebuffer(c.dev, cfb, NULL);
	vkDestroyRenderPass(c.dev, crp, NULL);
	vkDestroyImageView(c.dev, dview, NULL);
	vkDestroyImage(c.dev, dimg, NULL);
	vkFreeMemory(c.dev, dmem, NULL);
	return bad;
}

int main(void)
{
	struct ctx c;
	ctx_init(&c, "vk-depth");
	int bad = run(&c, 0);
	printf("  (negative viewport height)\n");
	bad += run(&c, 1);
	printf("  (depth cleared by a render pass of its own, then loaded)\n");
	bad += run(&c, 2);
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
	printf("vk-depth: %s\n", bad ? "FAIL" : "ok");
	return bad ? 1 : 0;
}
