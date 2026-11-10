import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./src/tasks.js";

const PORT = Number(process.env.PORT ?? 4317);
const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const store = createStore(process.env.SEED === "0" ? [] : ["Draft the quarterly report", "Book venue for offsite"]);

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/api/tasks" && req.method === "GET") return json(res, 200, store.list());
    if (req.url === "/api/tasks" && req.method === "POST") {
      const { title } = await readBody(req);
      return json(res, 201, store.add(title));
    }
    const path = req.url === "/" ? "/index.html" : req.url;
    const file = await readFile(join(PUBLIC, path.replace(/\.\./g, "")));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(file);
  } catch (err) {
    if (err.code === "ENOENT") return json(res, 404, { error: "not found" });
    json(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`tasks-app on http://127.0.0.1:${PORT}`));
