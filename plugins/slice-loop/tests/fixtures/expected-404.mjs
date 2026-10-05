export default async function ({ page, step, baseURL }) {
  await step("open board", () => page.goto(baseURL + "/"));
  await step("request a missing resource", () => page.evaluate(() => fetch("/api/missing")));
  await page.waitForTimeout(200);
}
