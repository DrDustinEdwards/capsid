// After a deploy (.github/workflows/explorer.yml): tells IndexNow the built sitemap's pages changed, with
// Prelum's submitIndexNow. A refused or failed ping is a warning; the engines then crawl on their own schedule.
import { readFileSync } from "node:fs";
import { recentSitemapUrls, submitIndexNow } from "@drdustinedwards/site-helpers/indexnow";
import { INDEXNOW_KEY, ORIGIN } from "./src/pages.mjs";

const urls = recentSitemapUrls(readFileSync(new URL("dist/sitemap.xml", import.meta.url), "utf8"));
if (!(await submitIndexNow({ origin: ORIGIN, key: INDEXNOW_KEY, urls }))) console.log("::warning::IndexNow did not accept the ping");
