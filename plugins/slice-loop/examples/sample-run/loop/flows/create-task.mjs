import assert from "node:assert/strict";

export default async function ({ page, step, capture, baseURL, expect }) {
  const items = page.getByRole("list", { name: "Tasks" }).getByRole("listitem");
  const title = `Water the plants ${Date.now()}`;

  await step("open board", async () => {
    await page.goto(baseURL + "/");
    await expect(items.first()).toBeVisible();
  });
  await capture("landing");

  const before = await step("count tasks", () => items.count());

  await step("add task", async () => {
    await page.getByLabel("Task title").fill(title);
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(title)).toBeVisible();
  });

  await step("list grew by one", async () => {
    await expect(items).toHaveCount(before + 1);
    assert.equal(await page.getByLabel("Task title").inputValue(), "");
  });
  await capture("task-added");
}
