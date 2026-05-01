import { useState } from "react";

type RunStatus = "Running" | "Completed" | "Failed" | "Queued";

type AgentRun = {
  id: number;
  title: string;
  prompt: string;
  status: RunStatus;
  model: string;
  time: string;
};

export default function Dashboard() {
  const [activeMenu, setActiveMenu] = useState("Dashboard");
  const [showModal, setShowModal] = useState(false);
  const [prompt, setPrompt] = useState("");

  const [runs, setRuns] = useState<AgentRun[]>([
    {
      id: 1,
      title: "Generate API docs",
      prompt: "Analyze the repository and generate API documentation.",
      status: "Completed",
      model: "Cursor Agent",
      time: "12 mins ago",
    },
    {
      id: 2,
      title: "Fix login bug",
      prompt: "Find and fix login validation issue.",
      status: "Running",
      model: "Cursor Agent",
      time: "2 mins ago",
    },
    {
      id: 3,
      title: "Refactor code",
      prompt: "Refactor dashboard components.",
      status: "Failed",
      model: "Cursor Agent",
      time: "25 mins ago",
    },
  ]);

  const menus = ["Dashboard", "Runs", "Prompts", "Settings"];

  const stats = {
    running: runs.filter((r) => r.status === "Running").length,
    completed: runs.filter((r) => r.status === "Completed").length,
    failed: runs.filter((r) => r.status === "Failed").length,
    queued: runs.filter((r) => r.status === "Queued").length,
  };

  function startAgent() {
    if (!prompt.trim()) return;

    const newRun: AgentRun = {
      id: Date.now(),
      title: prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt,
      prompt,
      status: "Queued",
      model: "Cursor Agent",
      time: "Just now",
    };

    setRuns((prev) => [newRun, ...prev]);
    setPrompt("");
    setShowModal(false);
    setActiveMenu("Runs");
  }

  return (
    <div className="min-h-screen bg-[#0f172a] text-white flex">
      {/* Sidebar */}
      <aside className="w-64 bg-[#020617] border-r border-slate-800 p-6 hidden md:block">
        <h2 className="text-xl font-bold mb-8">Cursor Agents</h2>

        <nav className="space-y-3 text-slate-300">
          {menus.map((menu) => (
            <button
              key={menu}
              onClick={() => setActiveMenu(menu)}
              className={`w-full text-left px-4 py-3 rounded-xl transition ${
                activeMenu === menu
                  ? "bg-slate-800 text-white"
                  : "hover:bg-slate-800"
              }`}
            >
              {menu}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="flex-1 p-8 overflow-auto">
        <div className="flex justify-between items-start gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-semibold">{activeMenu}</h1>
            <p className="text-slate-400 mt-1">
              {activeMenu === "Dashboard" &&
                "Monitor and manage Cursor agent runs in one place."}
              {activeMenu === "Runs" && "View all agent execution history."}
              {activeMenu === "Prompts" &&
                "Manage reusable prompts for agent workflows."}
              {activeMenu === "Settings" && "Configure dashboard preferences."}
            </p>
          </div>

          <button
            onClick={() => setShowModal(true)}
            className="bg-gradient-to-r from-blue-500 to-indigo-600 px-6 py-3 rounded-xl font-semibold shadow-lg hover:scale-105 transition"
          >
            Start Agent
          </button>
        </div>

        {activeMenu === "Dashboard" && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
            <section className="xl:col-span-2">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-8">
                <Card title="Running Agents" value={stats.running} color="text-blue-400" />
                <Card title="Completed Runs" value={stats.completed} color="text-green-400" />
                <Card title="Failed Runs" value={stats.failed} color="text-red-400" />
                <Card title="Queued Runs" value={stats.queued} color="text-yellow-400" />
              </div>

              <Panel title="Recent Runs">
                {runs.slice(0, 5).map((run) => (
                  <RunItem key={run.id} run={run} />
                ))}
              </Panel>
            </section>

            <Panel title="Agent Activity">
              {runs.slice(0, 5).map((run) => (
                <Activity key={run.id} run={run} />
              ))}
            </Panel>
          </div>
        )}

        {activeMenu === "Runs" && (
          <Panel title="All Runs">
            {runs.map((run) => (
              <RunItem key={run.id} run={run} showPrompt />
            ))}
          </Panel>
        )}

        {activeMenu === "Prompts" && (
          <Panel title="Prompt Library">
            <PromptCard title="Generate API documentation" />
            <PromptCard title="Refactor legacy code" />
            <PromptCard title="Create unit tests" />
            <PromptCard title="Analyze repository structure" />
          </Panel>
        )}

        {activeMenu === "Settings" && (
          <Panel title="Settings">
            <Setting label="Theme" value="Dark" />
            <Setting label="Default View" value="Dashboard" />
            <Setting label="Agent Provider" value="Cursor Agent" />
          </Panel>
        )}
      </main>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-[#1e293b] w-full max-w-xl rounded-2xl border border-slate-700 p-6 shadow-2xl">
            <h2 className="text-xl font-semibold mb-4">Start New Agent</h2>

            <label className="text-sm text-slate-400">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full mt-2 h-32 bg-[#0f172a] border border-slate-700 rounded-xl p-4 text-white outline-none"
              placeholder="Example: Analyze this repository and generate API documentation..."
            />

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowModal(false)}
                className="px-5 py-2 rounded-xl bg-slate-700"
              >
                Cancel
              </button>

              <button
                onClick={startAgent}
                className="px-5 py-2 rounded-xl bg-blue-600 font-semibold"
              >
                Run Agent
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({
  title,
  value,
  color,
}: {
  title: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-[#1e293b] p-6 rounded-2xl shadow-lg border border-slate-700">
      <p className="text-slate-400">{title}</p>
      <h2 className={`text-4xl font-bold mt-2 ${color}`}>{value}</h2>
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[#1e293b] p-6 rounded-2xl border border-slate-700 shadow-lg h-fit">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function RunItem({ run, showPrompt = false }: { run: AgentRun; showPrompt?: boolean }) {
  return (
    <div className="bg-[#0f172a] p-4 rounded-xl border border-slate-800">
      <div className="flex justify-between items-center gap-4">
        <div>
          <p className="font-medium">{run.title}</p>
          <p className="text-sm text-slate-500">{run.model} • {run.time}</p>
        </div>
        <StatusBadge status={run.status} />
      </div>

      {showPrompt && (
        <p className="text-sm text-slate-400 mt-3">{run.prompt}</p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const styles: Record<RunStatus, string> = {
    Running: "bg-blue-500/10 text-blue-400 border-blue-500/30",
    Completed: "bg-green-500/10 text-green-400 border-green-500/30",
    Failed: "bg-red-500/10 text-red-400 border-red-500/30",
    Queued: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  };

  return (
    <span className={`px-3 py-1 rounded-full text-sm border ${styles[status]}`}>
      {status}
    </span>
  );
}

function Activity({ run }: { run: AgentRun }) {
  const colorMap: Record<RunStatus, string> = {
    Running: "border-blue-400",
    Completed: "border-green-400",
    Failed: "border-red-400",
    Queued: "border-yellow-400",
  };

  return (
    <div className={`border-l-2 ${colorMap[run.status]} pl-4`}>
      <p className="font-medium">{run.title}</p>
      <p className="text-sm text-slate-400">{run.time}</p>
    </div>
  );
}

function PromptCard({ title }: { title: string }) {
  return (
    <div className="bg-[#0f172a] p-4 rounded-xl border border-slate-800 flex justify-between">
      <span>{title}</span>
      <span className="text-slate-400">Saved</span>
    </div>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#0f172a] p-4 rounded-xl border border-slate-800 flex justify-between">
      <span className="text-slate-400">{label}</span>
      <span>{value}</span>
    </div>
  );
}