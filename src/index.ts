import { Hono } from "hono";

export type Env = {
  KV: KVNamespace;
  ADMIN_PASSWORD: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.json({
    name: "tavily-cf-proxy",
    status: "ok",
    endpoints: {
      search: "POST /search",
      admin: "/admin",
    },
  });
});

export default app;
