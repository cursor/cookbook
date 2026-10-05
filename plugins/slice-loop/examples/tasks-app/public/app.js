const list = document.getElementById("list");
const form = document.getElementById("add-form");
const input = document.getElementById("title");

function render(tasks) {
  list.innerHTML = "";
  if (tasks.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No tasks yet. Add one above.";
    list.append(li);
    return;
  }
  for (const task of tasks) {
    const li = document.createElement("li");
    li.textContent = task.title;
    list.append(li);
  }
}

async function refresh() {
  const res = await fetch("/api/tasks");
  render(await res.json());
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await fetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: input.value }),
  });
  input.value = "";
  await refresh();
});

refresh();
