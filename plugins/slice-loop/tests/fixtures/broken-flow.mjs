export default async function ({ page, step, baseURL, expect }) {
  await step("open board", () => page.goto(baseURL + "/"));
  await step("find a task that does not exist", () => expect(page.getByText("No such task")).toBeVisible());
}
