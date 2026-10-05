import assert from "node:assert/strict";

export default async function ({ page, step, capture, baseURL, expect }) {
  const input = page.getByLabel("Task title");
  const add = page.getByRole("button", { name: "Add" });
  const items = page.getByRole("list", { name: "Tasks" }).getByRole("listitem");
  const message = page.getByText("Title is required", { exact: true });

  const assertMessageUnderInput = async () => {
    await expect(message).toBeVisible();
    const field = await input.boundingBox();
    const text = await message.boundingBox();
    assert.ok(text.y >= field.y + field.height, `message top ${text.y} is not below input bottom ${field.y + field.height}`);
    assert.ok(text.x < field.x + field.width && text.x + text.width > field.x, "message is not horizontally under the input");
  };

  await step("open board", async () => {
    await page.goto(baseURL + "/");
    await expect(items.first()).toBeVisible();
  });
  const before = await step("count tasks", () => items.count());

  await step("AC-4: submit empty title", async () => {
    await input.fill("");
    await add.click();
    await assertMessageUnderInput();
    assert.equal(await items.count(), before);
  });

  await step("AC-4: submit whitespace-only title", async () => {
    await input.fill("    ");
    await add.click();
    await assertMessageUnderInput();
    assert.equal(await items.count(), before);
  });
  await capture("AC-4-error");

  const title = `Renew passport ${Date.now()}`;
  await step("AC-5: submit a valid title", async () => {
    await input.fill(title);
    await add.click();
    await expect(page.getByText(title)).toBeVisible();
    await expect(items).toHaveCount(before + 1);
  });

  await step("AC-5: message cleared", () => expect(message).toBeHidden());
  await capture("AC-5-cleared");
}
