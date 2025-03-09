#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"
import { googleSearch } from "./search.js"
import { CommandOptions } from "./types.js"

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 配置
const STATE_FILE_PATH = path.join(os.homedir(), ".google-search-browser-state.json")
const DEFAULT_TIMEOUT = 60000 // 60秒
const DEFAULT_LIMIT = 10 // 默认返回10条结果
const DEFAULT_LANGUAGE = "zh-CN" // 默认语言
const DEFAULT_REGION = "cn" // 默认地区

// 创建 MCP 服务器
const server = new McpServer({
  name: "Google Search MCP",
  version: "1.0.0",
  description: "基于 Playwright 的 Google 搜索 MCP 服务器"
})

// 添加 Google 搜索工具
server.tool(
  "search",
  { 
    query: z.string().describe("搜索查询字符串"),
    limit: z.number().optional().describe("返回的搜索结果数量，默认为10"),
    timeout: z.number().optional().describe("搜索操作的超时时间(毫秒)，默认为60000"),
    language: z.string().optional().describe("搜索结果的语言，例如 zh-CN, en-US 等，默认为 zh-CN"),
    region: z.string().optional().describe("搜索结果的地区，例如 cn, com, co.jp 等，默认为 cn")
  },
  async ({ 
    query, 
    limit = DEFAULT_LIMIT, 
    timeout = DEFAULT_TIMEOUT,
    language = DEFAULT_LANGUAGE,
    region = DEFAULT_REGION
  }: { 
    query: string; 
    limit?: number; 
    timeout?: number;
    language?: string;
    region?: string;
  }) => {
    try {
      // 构建搜索选项
      const options: CommandOptions = {
        limit,
        timeout,
        stateFile: STATE_FILE_PATH,
        locale: language,
        region
      }
      
      // 执行搜索
      const results = await googleSearch(query, options)
      
      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify(results, null, 2)
        }]
      }
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `执行 Google 搜索时出错: ${error.message}` }],
        isError: true
      }
    }
  }
)

// 启动服务器
async function main() {
  try {
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error("Google Search MCP 服务器已启动")
  } catch (error: any) {
    console.error("启动 Google Search MCP 服务器时出错:", error)
    process.exit(1)
  }
}

main()
