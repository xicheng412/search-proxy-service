import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // 门户冒烟测试整包引入 src/index 时必须可解析 queue.ts 的 workerd 专属模块。
      "cloudflare:workers": path.join(here, "tests/helpers/cloudflare-workers-stub.ts"),
    },
  },
});
