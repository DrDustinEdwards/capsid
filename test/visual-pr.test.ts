import assert from "node:assert/strict";
import { test } from "node:test";
import { isVisual, previewUrl, screenshotUrls, visualDetails } from "../src/visual-pr.ts";

// What Dustin looks at before a visual pull request merges (job_0368576da167).

test("the visual label is read in any letter case, and only that label counts", () => {
  assert.equal(isVisual({ labels: [{ name: "Visual" }] }), true);
  assert.equal(isVisual({ labels: ["visual"] }), true);
  assert.equal(isVisual({ labels: [{ name: "visuals" }, { name: "docs" }] }), false);
  assert.equal(isVisual({ labels: null }), false);
});

test("the preview is the URL on a line saying preview, else the first Worker or Pages URL, never an image", () => {
  assert.equal(previewUrl("Before and after below.\nPreview: https://sample.example.com/x"), "https://sample.example.com/x");
  assert.equal(previewUrl("See https://github.com/o/r/pull/1 and https://pr-3.sample.pages.dev/home."), "https://pr-3.sample.pages.dev/home.");
  assert.equal(previewUrl("![preview](https://example.com/shot.png)"), null);
  assert.equal(previewUrl("Preview image https://example.com/shot.png"), null);
  assert.equal(previewUrl("No links here."), null);
});

test("screenshots are markdown images and img tags, each once, in order, at most 12", () => {
  const body = '![a](https://example.com/a.png) <img src="https://example.com/b.png" width="300"> ![a again](https://example.com/a.png)';
  assert.deepEqual(screenshotUrls(body), ["https://example.com/a.png", "https://example.com/b.png"]);
  const many = Array.from({ length: 15 }, (_, i) => `![s](https://example.com/${i}.png)`).join("\n");
  assert.equal(screenshotUrls(many).length, 12);
  assert.deepEqual(screenshotUrls("![local](./shot.png) ![http](http://example.com/x.png)"), [], "only https images");
});

test("the details carry the title, or say there is none", () => {
  assert.deepEqual(visualDetails({ title: "  ", body: null }), { title: "(no title)", preview: null, shots: [] });
});
