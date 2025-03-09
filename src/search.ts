import { chromium, devices, BrowserContextOptions, Browser, Response } from "playwright";
import { SearchResponse, SearchResult, CommandOptions } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import logger from "./logger.js";

// 指纹配置接口
interface FingerprintConfig {
  deviceName: string;
  locale: string;
  timezoneId: string;
  colorScheme: "dark" | "light";
  reducedMotion: "reduce" | "no-preference";
  forcedColors: "active" | "none";
}

// 保存的状态文件接口
interface SavedState {
  fingerprint?: FingerprintConfig;
  googleDomain?: string;
}

/**
 * 获取宿主机器的实际配置
 * @param userLocale 用户指定的区域设置（如果有）
 * @returns 基于宿主机器的指纹配置
 */
function getHostMachineConfig(userLocale?: string): FingerprintConfig {
  // 获取系统区域设置
  const systemLocale = userLocale || process.env.LANG || "zh-CN";

  // 获取系统时区
  // Node.js 不直接提供时区信息，但可以通过时区偏移量推断
  const timezoneOffset = new Date().getTimezoneOffset();
  let timezoneId = "Asia/Shanghai"; // 默认使用上海时区

  // 根据时区偏移量粗略推断时区
  // 时区偏移量是以分钟为单位，与UTC的差值，负值表示东区
  if (timezoneOffset <= -480 && timezoneOffset > -600) {
    // UTC+8 (中国、新加坡、香港等)
    timezoneId = "Asia/Shanghai";
  } else if (timezoneOffset <= -540) {
    // UTC+9 (日本、韩国等)
    timezoneId = "Asia/Tokyo";
  } else if (timezoneOffset <= -420 && timezoneOffset > -480) {
    // UTC+7 (泰国、越南等)
    timezoneId = "Asia/Bangkok";
  } else if (timezoneOffset <= 0 && timezoneOffset > -60) {
    // UTC+0 (英国等)
    timezoneId = "Europe/London";
  } else if (timezoneOffset <= 60 && timezoneOffset > 0) {
    // UTC-1 (欧洲部分地区)
    timezoneId = "Europe/Berlin";
  } else if (timezoneOffset <= 300 && timezoneOffset > 240) {
    // UTC-5 (美国东部)
    timezoneId = "America/New_York";
  }

  // 检测系统颜色方案
  const hour = new Date().getHours();
  const colorScheme =
    hour >= 19 || hour < 7 ? ("dark" as const) : ("light" as const);

  // 其他设置使用合理的默认值
  const reducedMotion = "no-preference" as const;
  const forcedColors = "none" as const;

  // 直接使用 Chrome 作为设备名称
  const deviceName = "Desktop Chrome";

  return {
    deviceName,
    locale: systemLocale,
    timezoneId,
    colorScheme,
    reducedMotion,
    forcedColors,
  };
}

/**
 * 执行Google搜索并返回结果
 * @param query 搜索关键词
 * @param options 搜索选项
 * @returns 搜索结果
 */
export async function googleSearch(
  query: string,
  options: CommandOptions = {},
  existingBrowser?: Browser
): Promise<SearchResponse> {
  // 设置默认选项
  const {
    limit = 10,
    timeout = 60000,
    stateFile = path.join(os.homedir(), ".google-search-browser-state.json"),
    noSaveState = false,
    locale = "zh-CN", // 默认使用中文
    region = "cn", // 默认使用中国区域
  } = options;

  // 状态文件路径
  const stateFilePath = path.resolve(stateFile);
  const fingerprintFilePath = stateFilePath.replace(
    ".json",
    "-fingerprint.json"
  );

  // 加载保存的状态
  let savedState: SavedState = {};
  let fingerprint: FingerprintConfig = getHostMachineConfig(locale);

  // 尝试加载指纹配置
  try {
    if (fs.existsSync(fingerprintFilePath)) {
      const fingerprintData = fs.readFileSync(fingerprintFilePath, "utf-8");
      fingerprint = JSON.parse(fingerprintData);
      logger.info("已加载浏览器指纹配置");
    } else {
      // 保存新生成的指纹配置
      fs.writeFileSync(
        fingerprintFilePath,
        JSON.stringify(fingerprint, null, 2)
      );
      logger.info("已生成并保存新的浏览器指纹配置");
    }
  } catch (error) {
    logger.warn("加载或保存浏览器指纹配置时出错，使用默认配置");
  }

  // 尝试加载保存的状态
  try {
    if (fs.existsSync(stateFilePath)) {
      const stateData = fs.readFileSync(stateFilePath, "utf-8");
      savedState = JSON.parse(stateData);
      logger.info("已加载保存的状态");
    }
  } catch (error) {
    logger.warn("加载保存的状态时出错，将使用新会话");
  }

  // 获取 Google 域名
  const googleDomain = savedState.googleDomain || `www.google.${region}`;

  // 忽略传入的headless参数，总是以无头模式启动
  let useHeadless = true;

  logger.info({ options }, "正在初始化浏览器...");

  // 检查是否存在状态文件
  let storageState: string | undefined = undefined;

  if (fs.existsSync(stateFilePath)) {
    logger.info(
      { stateFile },
      "发现浏览器状态文件，将使用保存的浏览器状态以避免反机器人检测"
    );
    storageState = stateFilePath;
  } else {
    logger.info(
      { stateFile },
      "未找到浏览器状态文件，将创建新的浏览器会话和指纹"
    );
  }

  // 获取随机延迟时间
  const getRandomDelay = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  // 定义一个函数来执行搜索，可以重用于无头和有头模式
  async function performSearch(headless: boolean): Promise<SearchResponse> {
    let browser: Browser;
    let browserWasProvided = false;

    if (existingBrowser) {
      browser = existingBrowser;
      browserWasProvided = true;
      logger.info("使用已存在的浏览器实例");
    } else {
      logger.info(
        { headless },
        `准备以${headless ? "无头" : "有头"}模式启动浏览器...`
      );

      // 初始化浏览器，添加更多参数以避免检测
      browser = await chromium.launch({
        headless,
        timeout: timeout * 2, // 增加浏览器启动超时时间
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials",
          "--disable-web-security",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-breakpad",
          "--disable-component-extensions-with-background-pages",
          "--disable-extensions",
          "--disable-features=TranslateUI",
          "--disable-ipc-flooding-protection",
          "--disable-renderer-backgrounding",
          "--enable-features=NetworkService,NetworkServiceInProcess",
          "--force-color-profile=srgb",
          "--metrics-recording-only",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });

      logger.info("浏览器已成功启动!");
    }

    // 使用统一的 Chrome 设备配置
    const deviceConfig = devices["Desktop Chrome"];

    // 创建浏览器上下文选项
    let contextOptions: BrowserContextOptions = {
      ...deviceConfig,
    };

    // 如果有保存的指纹配置，使用它；否则使用宿主机器的实际设置
    if (savedState.fingerprint) {
      contextOptions = {
        ...contextOptions,
        locale: savedState.fingerprint.locale,
        timezoneId: savedState.fingerprint.timezoneId,
        colorScheme: savedState.fingerprint.colorScheme,
        reducedMotion: savedState.fingerprint.reducedMotion,
        forcedColors: savedState.fingerprint.forcedColors,
      };
      logger.info("使用保存的浏览器指纹配置");
    } else {
      // 获取宿主机器的实际设置
      const hostConfig = getHostMachineConfig(locale);

      contextOptions = {
        ...contextOptions,
        locale: hostConfig.locale,
        timezoneId: hostConfig.timezoneId,
        colorScheme: hostConfig.colorScheme,
        reducedMotion: hostConfig.reducedMotion,
        forcedColors: hostConfig.forcedColors,
      };

      // 保存新生成的指纹配置
      savedState.fingerprint = hostConfig;
      logger.info(
        {
          locale: hostConfig.locale,
          timezone: hostConfig.timezoneId,
          colorScheme: hostConfig.colorScheme,
          deviceType: hostConfig.deviceName,
        },
        "已根据宿主机器生成新的浏览器指纹配置"
      );
    }

    // 添加通用选项 - 确保使用桌面配置
    contextOptions = {
      ...contextOptions,
      permissions: ["geolocation", "notifications"],
      acceptDownloads: true,
      isMobile: false, // 强制使用桌面模式
      hasTouch: false, // 禁用触摸功能
      javaScriptEnabled: true,
    };

    if (storageState) {
      logger.info("正在加载保存的浏览器状态...");
    }

    const context = await browser.newContext(
      storageState ? { ...contextOptions, storageState } : contextOptions
    );

    // 设置额外的浏览器属性以避免检测
    await context.addInitScript(() => {
      // 覆盖 navigator 属性
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en", "zh-CN"],
      });

      // 覆盖 window 属性
      // @ts-ignore - 忽略 chrome 属性不存在的错误
      window.chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };

      // 添加 WebGL 指纹随机化
      if (typeof WebGLRenderingContext !== "undefined") {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (
          parameter: number
        ) {
          // 随机化 UNMASKED_VENDOR_WEBGL 和 UNMASKED_RENDERER_WEBGL
          if (parameter === 37445) {
            return "Intel Inc.";
          }
          if (parameter === 37446) {
            return "Intel Iris OpenGL Engine";
          }
          return getParameter.call(this, parameter);
        };
      }
    });

    const page = await context.newPage();

    // 设置页面额外属性
    await page.addInitScript(() => {
      // 模拟真实的屏幕尺寸和颜色深度
      Object.defineProperty(window.screen, "width", { get: () => 1920 });
      Object.defineProperty(window.screen, "height", { get: () => 1080 });
      Object.defineProperty(window.screen, "colorDepth", { get: () => 24 });
      Object.defineProperty(window.screen, "pixelDepth", { get: () => 24 });
    });

    try {
      logger.info("正在访问Google搜索页面...");

      // 统一使用 www.google.com 作为域名
      const selectedDomain = "www.google.com";
      // 保存选择的域名
      savedState.googleDomain = selectedDomain;

      // 构建搜索URL
      const searchUrl = `https://${selectedDomain}/search?q=${encodeURIComponent(
        query
      )}&hl=${locale}`;

      logger.info({ url: searchUrl, query, locale }, "正在访问Google搜索页面");

      // 尝试访问Google搜索页面，带重试机制
      let response: Response | null = null;
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        try {
          // 访问Google搜索页面
          response = await page.goto(searchUrl, {
            timeout: timeout * 2, // 增加超时时间
            waitUntil: "domcontentloaded", // 改用 domcontentloaded 而不是 networkidle
          });
          
          // 如果成功加载页面，跳出循环
          if (response && response.ok()) {
            logger.info("页面加载成功");
            break;
          }
          
          logger.warn({ 
            status: response?.status(), 
            url: response?.url(),
            retry: retryCount + 1
          }, "页面加载不成功，准备重试");
          
          // 等待一段时间后重试
          await page.waitForTimeout(2000);
          retryCount++;
        } catch (error) {
          logger.error({ error: error instanceof Error ? error.message : String(error), retry: retryCount + 1 }, "页面加载出错");
          
          // 等待一段时间后重试
          await page.waitForTimeout(2000);
          retryCount++;
        }
      }

      // 如果所有重试都失败，抛出错误
      if (retryCount >= maxRetries && (!response || !response.ok())) {
        throw new Error(`无法加载Google搜索页面，已重试${maxRetries}次`);
      }

      // 检查是否被重定向到人机验证页面
      const currentUrl = page.url();
      logger.info({ currentUrl }, "当前页面URL");

      const sorryPatterns = [
        "google.com/sorry/index",
        "google.com/sorry",
        "recaptcha",
        "captcha",
        "unusual traffic",
      ];

      const isBlockedPage = sorryPatterns.some(
        (pattern) =>
          currentUrl.includes(pattern) ||
          (response && response.url().includes(pattern))
      );

      if (isBlockedPage) {
        logger.warn("检测到人机验证页面");
        if (headless) {
          // 在无头模式下，转为有头模式重试
          await page.close();
          await context.close();
          if (!browserWasProvided) {
            await browser.close();
            return performSearch(false); // 以有头模式重新执行搜索
          }
          throw new Error("检测到人机验证页面，请尝试有头模式或手动验证");
        } else {
          logger.warn("请在浏览器中完成验证...");
          throw new Error("检测到人机验证页面，需要手动完成验证");
        }
      }

      // 检查URL是否已经包含搜索查询
      const isSearchResultPage = currentUrl.includes("/search") && currentUrl.includes("q=");
      
      // 如果已经是搜索结果页面，跳过输入搜索关键词的步骤
      if (isSearchResultPage) {
        logger.info({ currentUrl }, "已经在搜索结果页面，跳过输入搜索关键词的步骤");
      } else {
        logger.info({ query }, "正在输入搜索关键词");

        // 等待搜索框出现 - 尝试多个可能的选择器
        const searchInputSelectors = [
          "textarea[name='q']",
          "input[name='q']",
          "textarea[title='Search']",
          "input[title='Search']",
          "textarea[aria-label='Search']",
          "input[aria-label='Search']",
          "textarea[aria-label='搜索']",
          "input[aria-label='搜索']",
          "#search-box",
          "#searchform input",
          "#searchbox",
          ".gLFyf",
          "textarea",
          "input[type='text']"
        ];

        // 尝试等待搜索框出现
        try {
          const selector = searchInputSelectors.join(',');
          logger.debug({ selector }, "等待搜索框选择器");
          // 使用更短的超时时间，避免长时间等待
          await page.waitForSelector(selector, { timeout: 10000 });
          logger.info({ selector }, "搜索框已出现");
        } catch (error) {
          // 处理 error 为 unknown 类型的情况
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn({ error: errorMessage }, "等待搜索框出现超时，将尝试直接查找");
        }

        let searchInput = null;
        for (const selector of searchInputSelectors) {
          logger.debug({ selector }, "尝试查找搜索框");
          searchInput = await page.$(selector);
          if (searchInput) {
            logger.info({ selector }, "找到搜索框");
            break;
          }
          logger.debug({ selector }, "未找到搜索框");
        }

        if (!searchInput) {
          // 分析页面内容
          logger.info("分析页面内容以查找问题...");
          
          // 获取页面标题
          const title = await page.title();
          logger.info({ title }, "页面标题");
          
          // 检查页面是否包含特定文本
          const pageContent = await page.content();
          const containsRecaptcha = pageContent.includes("recaptcha") || pageContent.includes("captcha");
          const containsRobot = pageContent.includes("robot") || pageContent.includes("automated");
          const containsError = pageContent.includes("error") || pageContent.includes("sorry");
          
          logger.info({ 
            containsRecaptcha, 
            containsRobot, 
            containsError,
            url: page.url()
          }, "页面内容分析");
          
          // 获取所有可见的输入元素
          const inputElements = await page.$$eval('input, textarea', elements => {
            return elements.map(el => ({
              type: el.tagName,
              id: el.id,
              name: (el as HTMLInputElement | HTMLTextAreaElement).name || '',
              class: el.className,
              placeholder: (el as HTMLInputElement | HTMLTextAreaElement).placeholder || '',
              visible: (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0
            }));
          });
          
          logger.info({ inputElements }, "页面上的输入元素");

          // 保存页面截图以便调试
          const screenshotPath = path.join(os.tmpdir(), `google-search-error-${Date.now()}.png`);
          try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            logger.error({ screenshotPath }, "已保存页面截图");
          } catch (screenshotError) {
            logger.error({ error: screenshotError }, "保存截图失败");
          }
          
          // 保存页面HTML以便调试
          const htmlPath = path.join(os.tmpdir(), `google-search-error-${Date.now()}.html`);
          try {
            const html = await page.content();
            fs.writeFileSync(htmlPath, html);
            logger.error({ htmlPath }, "已保存页面HTML");
          } catch (htmlError) {
            logger.error({ error: htmlError }, "保存HTML失败");
          }
          
          logger.error("无法找到搜索框");
          throw new Error("无法找到搜索框");
        }

        // 直接点击搜索框，减少延迟
        await searchInput.click();

        // 直接输入整个查询字符串，而不是逐个字符输入
        await page.keyboard.type(query, { delay: getRandomDelay(10, 30) });

        // 减少按回车前的延迟
        await page.waitForTimeout(getRandomDelay(100, 300));
        await page.keyboard.press("Enter");

        logger.info("正在等待页面加载完成...");

        // 等待页面加载完成
        await page.waitForLoadState("domcontentloaded", { timeout });
      }

      logger.info({ url: page.url() }, "正在等待搜索结果加载...");

      // 等待搜索结果加载
      try {
        await page.waitForSelector("#search, #rso, .g, [data-sokoban-container], div[role='main']", { 
          timeout: timeout / 2 
        });
        logger.info("搜索结果已加载");
      } catch (error) {
        logger.error("无法找到搜索结果元素");
        throw new Error("无法找到搜索结果元素");
      }

      // 减少等待时间
      await page.waitForTimeout(500);

      logger.info("正在提取搜索结果...");

      // 提取搜索结果
      const results = await page.$$eval(
        ".g, [data-sokoban-container] > div",
        (elements, maxResults) => {
          return elements
            .slice(0, maxResults)
            .map((el) => {
              const titleElement = el.querySelector("h3");
              const linkElement = el.querySelector("a");
              const snippetElement = el.querySelector(".VwiC3b, [data-sncf='1']");

              return {
                title: titleElement ? titleElement.textContent || "" : "",
                link: linkElement && linkElement instanceof HTMLAnchorElement
                  ? linkElement.href
                  : "",
                snippet: snippetElement ? snippetElement.textContent || "" : "",
              };
            })
            .filter((item) => item.title && item.link); // 过滤掉空结果
        },
        limit
      );

      logger.info({ count: results.length }, "成功获取到搜索结果");

      try {
        // 保存浏览器状态（除非用户指定了不保存）
        if (!noSaveState) {
          logger.info({ stateFile }, "正在保存浏览器状态...");

          // 确保目录存在
          const stateDir = path.dirname(stateFilePath);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }

          // 保存状态
          await context.storageState({ path: stateFilePath });
          
          // 保存指纹配置
          fs.writeFileSync(
            fingerprintFilePath,
            JSON.stringify(savedState, null, 2),
            "utf8"
          );
          
          logger.info("浏览器状态和指纹配置已保存");
        }
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, "保存状态时发生错误");
      }

      // 关闭浏览器（如果不是外部提供的）
      if (!browserWasProvided) {
        await browser.close();
      }

      // 返回搜索结果
      return {
        query,
        results,
        language: locale,
        region
      };
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, "搜索过程中发生错误");

      // 尝试关闭资源
      try {
        if (!browserWasProvided && browser) {
          await browser.close();
        }
      } catch (closeError) {
        logger.error({ error: closeError instanceof Error ? closeError.message : String(closeError) }, "关闭浏览器时发生错误");
      }

      // 返回错误结果
      return {
        query,
        results: [
          {
            title: "搜索失败",
            link: "",
            snippet: `无法完成搜索，错误信息: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        language: locale,
        region,
      };
    }
  }

  // 执行搜索，返回结果
  return performSearch(useHeadless);
}
