/**
 * vikunja-session: link the current pi session to a Vikunja task.
 *
 * Usage:
 *   /vikunja                - show current link status
 *   /vikunja <url|id>       - link this session to a task, e.g. /vikunja 30 or /vikunja https://vikunja.example.com/tasks/30
 *   /vikunja <其他文本>      - 不是任务引用时：在配置的默认项目里创建该标题的任务并绑定
 *   /vikunja off            - unlink
 *
 * On link: adds a comment to the Vikunja task containing the pi-web session URL.
 * On agent_settled (agent finished running): adds a completion comment. (Task is NOT auto-marked done.)
 *
 * Config: ~/.pi/agent/vikunja-session.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "vikunja-session.json");
const STATE_TYPE = "vikunja-session";

interface Config {
  vikunja: { baseUrl: string; token: string; defaultProjectId?: number };
  authelia: { baseUrl: string; username: string; password: string };
  piweb: { baseUrl: string; apiBase: string };
}

// Secrets (vikunja.token, authelia.username/password) live ONLY in the JSON
// config file — never hardcode them here. Non-secret defaults stay in code.
// All values must come from the JSON config — no site-specific defaults here.
const DEFAULT_CONFIG: Config = {
  vikunja: {
    baseUrl: "",
    token: "",
  },
  authelia: {
    baseUrl: "",
    username: "",
    password: "",
  },
  piweb: {
    // baseUrl: 浏览器访问 pi-web 的地址（用于会话链接）
    baseUrl: "",
    // apiBase: 本机解析 project/workspace id 用的 pi-web API（不走网关认证）
    apiBase: "",
  },
};

interface LinkState {
  taskId: number;
  status: "linked" | "done" | "unlinked";
  sessionUrl?: string; // 仅历史兼容；新代码一律现算当前会话 URL，不用存储值
}

function loadConfig(): Config {
  let raw: Partial<Config> = {};
  try {
    if (existsSync(CONFIG_PATH)) {
      raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } else {
      // Write a template (empty secrets) so the user can fill it in.
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", {
        mode: 0o600,
      });
    }
  } catch (err) {
    console.error("[vikunja-session] failed to read config:", err);
  }
  const config: Config = {
    vikunja: {
      ...DEFAULT_CONFIG.vikunja,
      ...(raw.vikunja ?? {}),
      defaultProjectId:
        raw.vikunja?.defaultProjectId ?? DEFAULT_CONFIG.vikunja.defaultProjectId,
    },
    authelia: { ...DEFAULT_CONFIG.authelia, ...(raw.authelia ?? {}) },
    piweb: { ...DEFAULT_CONFIG.piweb, ...(raw.piweb ?? {}) },
  };
  if (
    !config.vikunja.baseUrl ||
    !config.vikunja.token ||
    !config.authelia.username ||
    !config.authelia.password
  ) {
    console.error(`[vikunja-session] missing configuration in ${CONFIG_PATH}`);
  }
  return config;
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  // Per-session link state. Keyed by session file path (or session id when ephemeral),
  // so the extension works when pi switches sessions within one process.
  const links = new Map<string, LinkState>();

  function sessionKey(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
  }

  // ---- Authelia session (公网域名在 Authelia 后面，需先登录拿 cookie) ----

  let autheliaCookie: string | undefined;

  async function autheliaLogin(): Promise<string> {
    const res = await fetch(`${config.authelia.baseUrl}/authelia/api/firstfactor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: config.authelia.username,
        password: config.authelia.password,
        keepMeLoggedIn: false,
        requestMethod: "GET",
      }),
      redirect: "manual",
    });
    if (!res.ok) throw new Error(`Authelia login -> HTTP ${res.status}`);
    const m = res.headers.get("set-cookie")?.match(/authelia_session=([^;]+)/);
    if (!m) throw new Error("Authelia login: no session cookie");
    return `authelia_session=${m[1]}`;
  }

  // ---- Vikunja API helpers ----

  async function vikunja(method: string, path: string, body?: unknown): Promise<unknown> {
    const doFetch = async (cookie?: string) =>
      fetch(`${config.vikunja.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.vikunja.token}`,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });

    let res = await doFetch(autheliaCookie);
    if (res.status === 302 || res.status === 303) {
      // 会话过期/未登录 → 重新登录后重试一次
      autheliaCookie = await autheliaLogin();
      res = await doFetch(autheliaCookie);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Vikunja ${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  function getTask(taskId: number): Promise<unknown> {
    return vikunja("GET", `/tasks/${taskId}`);
  }

  function createTask(projectId: number, title: string): Promise<{ id: number }> {
    return vikunja("PUT", `/projects/${projectId}/tasks`, { title }) as Promise<{ id: number }>;
  }

  function addComment(taskId: number, comment: string): Promise<void> {
    return vikunja("PUT", `/tasks/${taskId}/comments`, { comment }) as Promise<void>;
  }

  // ---- pi-web: resolve project/workspace ids for the session URL ----

  interface PiWebIds {
    projectId?: string;
    workspaceId?: string;
  }

  // pi-web 项目/工作区 id 按 cwd 缓存，避免每次评论都请求
  const piWebIdsCache = new Map<string, PiWebIds>();

  async function resolvePiWebIds(cwd: string): Promise<PiWebIds> {
    const cached = piWebIdsCache.get(cwd);
    if (cached) return cached;
    let ids: PiWebIds = {};
    try {
      const res = await fetch(`${config.piweb.apiBase}/api/projects`);
      if (!res.ok) return {};
      const projects = (await res.json()) as Array<{ id: string; path: string }>;
      // Longest path prefix match: cwd == project.path, or cwd inside the project folder.
      const project = projects
        .filter((p) => cwd === p.path || cwd.startsWith(p.path + "/"))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (project) {
        ids = { projectId: project.id };
        const wsRes = await fetch(`${config.piweb.apiBase}/api/projects/${project.id}/workspaces`);
        if (wsRes.ok) {
          const data = (await wsRes.json()) as {
            workspaces?: Array<{ id: string; path: string; isMain?: boolean }>;
          };
          const workspaces = data.workspaces ?? [];
          const workspace =
            workspaces.find((w) => w.path === cwd) ?? workspaces.find((w) => w.isMain);
          ids.workspaceId = workspace?.id;
        }
      }
    } catch (err) {
      console.error("[vikunja-session] failed to resolve pi-web ids:", err);
    }
    piWebIdsCache.set(cwd, ids);
    return ids;
  }

  function sessionUrl(sessionId: string, ids: PiWebIds): string | undefined {
    if (!ids.projectId || !ids.workspaceId) return undefined;
    const params = new URLSearchParams({
      project: ids.projectId,
      workspace: ids.workspaceId,
      session: sessionId,
    });
    return `${config.piweb.baseUrl}/?${params.toString()}`;
  }

  // 评论是富文本（HTML）格式：用 <a> 链接（URL 中 & 需转义为 &amp;）
  function linkHtml(url: string): string {
    return `<a href="${url.replaceAll("&", "&amp;")}" target="_blank" rel="noopener noreferrer nofollow">🔗 Pi 会话</a>`;
  }

  // 现算当前会话的链接：sessionId 永远是当前会话，绝不使用历史存储值（fork/恢复会带旧 session）
  async function getCurrentSessionUrl(ctx: ExtensionContext): Promise<string | undefined> {
    const ids = await resolvePiWebIds(ctx.cwd);
    return sessionUrl(ctx.sessionManager.getSessionId(), ids);
  }

  // ---- parse task reference ----

  function parseTaskRef(raw: string): number | null {
    const s = raw.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
    const m = s.match(/\/tasks\/(\d+)\b/);
    return m ? Number(m[1]) : null;
  }

  // ---- restore state on session start ----

  // 子会话（spawn_session / spawn_subsession 创建）从父会话继承 vikunja 绑定：
  // 读父会话文件里最后一条 vikunja-session entry，快照进本会话（clone 语义，之后互不影响）。
  // fork/clone 因为整份拷贝了 entries，走不到这里（上面的自己-entry 恢复已命中）。
  async function inheritFromParent(ctx: ExtensionContext, key: string) {
    const parentPath = ctx.sessionManager.getHeader()?.parentSession;
    if (!parentPath || !existsSync(parentPath)) return;
    try {
      let latest: LinkState | undefined;
      for (const line of readFileSync(parentPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let obj: { type?: string; customType?: string; data?: LinkState };
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj?.type === "custom" && obj.customType === STATE_TYPE) latest = obj.data;
      }
      if (!latest || latest.status === "unlinked") return;

      links.set(key, latest);
      pi.appendEntry(STATE_TYPE, latest); // 快照进本会话，之后 /vikunja off 不影响父会话
      try {
        const task = (await getTask(latest.taskId).catch(() => null)) as
          | { title?: string; index?: number }
          | null;
        renameWithTaskPrefix(ctx, task, latest.taskId);
      } catch {
        /* 任务可能已删除，重命名失败不影响继承 */
      }
      ctx.ui.notify(`已继承父会话的 Vikunja 任务 #${latest.taskId}`, "info");
    } catch (err) {
      console.error("[vikunja-session] failed to inherit from parent:", err);
    }
  }

  pi.on("session_start", async (event, ctx) => {
    const key = sessionKey(ctx);

    // 本会话自己的 entry（fork/clone 整份拷贝进来；最后一条生效，覆盖 /vikunja off 和重新关联）
    // Entries are chronological; the last record wins (covers /vikunja off and re-linking).
    let latest: LinkState | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        latest = entry.data as LinkState;
      }
    }
    if (latest && latest.status !== "unlinked") {
      links.set(key, latest);
      return;
    }
    // 自己没有 → 从父会话继承（spawn_session / spawn_subsession 的子会话在文件头记录了父会话）
    await inheritFromParent(ctx, key);
  });

  // ---- /vikunja command ----

  /** 会话名改成任务前缀【#index-任务id 标题】（如【#11-40 写周报】），保留名字主体；
   *  已对得上（含相同标题）→ 不动；对不上（换绑/旧前缀/标题更新）→ 去旧换新；没前缀→直接加 */
  function renameWithTaskPrefix(
    ctx: ExtensionContext,
    task: { title?: string; index?: number } | null,
    taskId: number,
  ) {
    const title = (task?.title ?? "").trim().replace(/\s+/g, " ");
    const prefix = `【#${task?.index ?? taskId}-${taskId}${title ? ` ${title}` : ""}】`;
    const currentName = pi.getSessionName();
    if (currentName?.startsWith(prefix)) return;
    const oldPrefix = currentName?.match(/^【#\d+-\d+[^】]*】/);
    const base = oldPrefix
      ? currentName!.slice(oldPrefix[0].length) // 去掉旧前缀，保留名字主体
      : (currentName ?? firstUserMessage(ctx));
    pi.setSessionName(`${prefix}${base}`);
  }

  pi.registerCommand("vikunja", {
    description:
      "Link this pi session to a Vikunja task: /vikunja <url|id> | /vikunja <标题: 在默认项目新建任务并绑定> | /vikunja off | /vikunja (show status)",
    handler: async (args, ctx) => {
      const key = sessionKey(ctx);
      const current = links.get(key);
      const arg = args.trim();

      if (!arg || arg === "status") {
        if (current) {
          ctx.ui.notify(
            `已关联 Vikunja 任务 #${current.taskId}（${current.status === "done" ? "已完成" : "等待完成"}）`,
            "info",
          );
        } else {
          ctx.ui.notify("本会话未关联 Vikunja 任务，用 /vikunja <url|id> 关联", "info");
        }
        return;
      }

      if (arg === "off") {
        if (current) {
          links.delete(key);
          pi.appendEntry(STATE_TYPE, { taskId: current.taskId, status: "unlinked" as const });
          ctx.ui.notify(`已解除关联 Vikunja 任务 #${current.taskId}`, "info");
        } else {
          ctx.ui.notify("本会话本来就没有关联任务", "info");
        }
        return;
      }

      let taskId = parseTaskRef(arg);
      let task: { title?: string; index?: number } | null = null;
      let created = false;

      if (taskId) {
        try {
          task = (await getTask(taskId)) as { title?: string; index?: number } | null; // verify the task exists
        } catch (err) {
          ctx.ui.notify(
            `Vikunja 任务 #${taskId} 不存在或无法访问: ${(err as Error).message}`,
            "error",
          );
          return;
        }
      } else {
        // 不是任务引用 → 把参数当标题，在默认项目里创建任务
        const projectId = config.vikunja.defaultProjectId;
        if (!projectId) {
          ctx.ui.notify(
            `无法解析任务: ${arg}。支持 /vikunja 30 / /vikunja <url>；或在 vikunja-session.json 配置 vikunja.defaultProjectId 后用标题创建任务`,
            "error",
          );
          return;
        }
        try {
          const t = (await createTask(projectId, arg)) as {
            id: number;
            title?: string;
            index?: number;
          };
          taskId = t.id;
          task = t;
          created = true;
        } catch (err) {
          ctx.ui.notify(
            `创建 Vikunja 任务失败: ${(err as Error).message}`,
            "error",
          );
          return;
        }
      }

      // 关联立即生效：先按任务重命名会话
      renameWithTaskPrefix(ctx, task, taskId);

      const url = await getCurrentSessionUrl(ctx);
      const state: LinkState = { taskId, status: "linked", sessionUrl: url };

      // 不再写关联评论；只在任务完成时留一条评论（含链接+用户最新消息）
      links.set(key, state);
      pi.appendEntry(STATE_TYPE, state);
      ctx.ui.notify(
        `${created ? `已创建并关联 Vikunja 任务 #${taskId}` : `已关联 Vikunja 任务 #${taskId}`}，agent 运行完后自动追加完成评论`,
        "info",
      );
    },
  });

  // 用户最新一条消息的文本（用于完成评论里带上前 50 字）
  function latestUserMessage(ctx: ExtensionContext): string {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const text = userMessageText(entries[i]);
      if (text) return text;
    }
    return "";
  }

  // 用户第一条消息（session 默认名 = 首条消息，加前缀时的基准名）
  function firstUserMessage(ctx: ExtensionContext): string {
    for (const entry of ctx.sessionManager.getEntries()) {
      const text = userMessageText(entry);
      if (text) return text;
    }
    return "";
  }

  function userMessageText(entry: unknown): string | undefined {
    const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (e.type !== "message" || e.message?.role !== "user") return undefined;
    const content = e.message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.find(
        (c) => c.type === "text" && typeof (c as { text?: unknown }).text === "string",
      ) as { text: string } | undefined;
      return text?.text;
    }
    return undefined;
  }

  // ---- add completion comment when the agent run settles ----

  pi.on("agent_settled", async (_event, ctx) => {
    const key = sessionKey(ctx);
    const link = links.get(key);
    // 只要绑定了任务，每次 agent 跑完都追加评论（不区分 linked/done 状态）
    if (!link) return;

    try {
      // 1) 会话名带任务前缀【#index-任务id 标题】（标题更新时顺带刷新）
      const task = (await getTask(link.taskId)) as {
        title?: string;
        description?: string;
        index?: number;
      } | null;
      renameWithTaskPrefix(ctx, task, link.taskId);

      // 2) 完成评论：链接用当前会话现算（不依赖存储的旧 sessionUrl）
      const url = await getCurrentSessionUrl(ctx);
      const linkText = url ? linkHtml(url) : "(链接未解析，请检查配置)";
      const snippet = latestUserMessage(ctx).slice(0, 50);
      const comment = `✅ 会话已完成 ${linkText}${snippet ? `\n${snippet}` : ""}`;
      await addComment(link.taskId, comment);
      ctx.ui.notify(`Vikunja 任务 #${link.taskId} 已追加完成评论`, "info");
    } catch (err) {
      console.error("[vikunja-session] failed to add completion comment:", err);
      ctx.ui.notify(
        `追加 Vikunja 任务 #${link.taskId} 完成评论失败: ${(err as Error).message}`,
        "error",
      );
    }
  });
}
