import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const start = "https://d2mxyt8j2p6hed.cloudfront.net/";
const origin = new URL(start).origin;
const output = path.resolve("site");
const seenPages = new Set();
const saved = new Map();
const queue = [start];

function localPath(raw) {
  const u = new URL(raw);
  let pathname = decodeURIComponent(u.pathname);
  if (!pathname || pathname.endsWith("/")) {
    pathname += "index.html";
  }

  pathname = pathname.replace(/^\/+/, "");
  if (pathname.split("/").some(p => p === "..")) {
    throw new Error("Unsafe path");
  }

  let dest = path.join(
    output, "_mirror", u.hostname, pathname
  );

  if (u.search) {
    const hash = crypto
      .createHash("sha256")
      .update(u.search)
      .digest("hex")
      .slice(0, 12);
    dest += "." + hash;
  }

  return dest;
}

async function writeResponse(url, body, contentType) {
  let dest;
  try {
    dest = localPath(url);
  } catch {
    return;
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, body);
  saved.set(url, { dest, contentType });
}

const browser = await chromium.launch({
  headless: true
});

const context = await browser.newContext({
  ignoreHTTPSErrors: false
});

const page = await context.newPage();
page.setDefaultTimeout(15000);

page.on("response", async response => {
  try {
    const url = response.url();
    const status = response.status();

    if (!url.startsWith("http") || status !== 200) return;

    const headers = await response.allHeaders();
    const type = headers["content-type"] || "";

    if (!/(text\/html|text\/css|javascript|json|image\/|font\/|application\/wasm|application\/octet-stream)/i.test(type)) {
      return;
    }

    const body = await response.body();
    await writeResponse(url, body, type);
  } catch (e) {
    console.log("Resource skipped:", response.url(), String(e).slice(0, 120));
  }
});

while (queue.length && seenPages.size < 30) {
  const url = queue.shift();
  if (seenPages.has(url)) continue;
  seenPages.add(url);

  console.log("Opening:", url);

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(5000);

    const links = await page.locator("a[href]")
      .evaluateAll(nodes =>
        nodes.map(a => a.href).filter(Boolean)
      );

    for (const link of links) {
      try {
        const u = new URL(link);
        u.hash = "";

        if (
          u.origin === origin &&
          !seenPages.has(u.href) &&
          queue.length < 100
        ) {
          queue.push(u.href);
        }
      } catch {}
    }

    const html = await page.content();

    if (url === start) {
      await fs.writeFile(
        path.join(output, "index.html"),
        html
      );
    } else {
      await writeResponse(
        url,
        Buffer.from(html),
        "text/html"
      );
    }
  } catch (e) {
    console.log("Page failed:", url, String(e).slice(0, 200));
  }
}

await browser.close();

// Rewrite absolute URLs for resources that were captured.
// Keep the original directory hierarchy under _mirror/.
const all = [...saved.entries()].sort(
  (a, b) => b[0].length - a[0].length
);

async function rewriteFile(file, baseUrl) {
  let content;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return;
  }

  if (content.includes("\u0000")) return;

  for (const [url, item] of all) {
    if (!/^https?:\/\//i.test(url)) continue;

    let relative = path.relative(
      path.dirname(file), item.dest
    ).split(path.sep).join("/");

    if (!relative.startsWith(".")) relative = "./" + relative;

    content = content.split(url).join(relative);
  }

  // Rewrite root-relative resource references in HTML and CSS.
  content = content.replace(
    /(["'(=:\s])\/(?!\/)([^"'()\s<>]*)/g,
    (match, prefix, resource) => {
      try {
        const absolute = new URL("/" + resource, baseUrl).href;
        const item = saved.get(absolute);
        if (!item) return match;

        let relative = path.relative(
          path.dirname(file), item.dest
        ).split(path.sep).join("/");

        if (!relative.startsWith(".")) relative = "./" + relative;
        return prefix + relative;
      } catch {
        return match;
      }
    }
  );

  await fs.writeFile(file, content);
}

for (const [url, item] of all) {
  if (/text\/(html|css)|javascript/i.test(item.contentType)) {
    await rewriteFile(item.dest, url);
  }
}

const files = await fs.readdir(output, {
  recursive: true
});

console.log("Pages visited:", seenPages.size);
console.log("Responses captured:", saved.size);
console.log("Files in mirror:", files.length);
console.log("Homepage:", path.join(output, "index.html"));
