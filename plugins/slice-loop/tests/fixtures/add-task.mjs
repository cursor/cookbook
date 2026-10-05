export default async function ({ page, step, capture, baseURL, expect }) {
  await step("open board", () => page.goto(baseURL + "/"));
  await expect(page.getByText("Draft the quarterly report")).toBeVisible();
  await capture("seeded");
  await step("add task", async () => {
    await page.getByLabel("Task title").fill("Write the loop docs");
    await page.getByRole("button", { name: "Add" }).click();
  });
  await expect(page.getByText("Write the loop docs")).toBeVisible();
  await capture("added");
}
