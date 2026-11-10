export function createStore(seed = []) {
  let nextId = 1;
  const tasks = [];

  const add = (title) => {
    const task = { id: nextId++, title: String(title).trim(), done: false };
    tasks.push(task);
    return task;
  };

  for (const title of seed) add(title);

  return {
    list: () => tasks.map((t) => ({ ...t })),
    add,
  };
}
