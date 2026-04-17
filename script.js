const STORAGE_KEY = "jamly-app-v2";
const MEMBERS = ["cold", "david", "圈", "星", "小安", "afai"];
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const OPEN_HOURS = Array.from({ length: 13 }, (_, index) => index + 10);
const REMOTE_SYNC_INTERVAL = 45000;

const dayAliases = {
  "周一": 0,
  "星期一": 0,
  "礼拜一": 0,
  "周二": 1,
  "星期二": 1,
  "礼拜二": 1,
  "周三": 2,
  "星期三": 2,
  "礼拜三": 2,
  "周四": 3,
  "星期四": 3,
  "礼拜四": 3,
  "周五": 4,
  "星期五": 4,
  "礼拜五": 4,
  "周六": 5,
  "星期六": 5,
  "礼拜六": 5,
  "周日": 6,
  "周天": 6,
  "星期日": 6,
  "星期天": 6,
  "礼拜日": 6,
  "礼拜天": 6
};

const timeWords = [
  { regex: /(全天|整天|都可以|都行|都有空|全都可以)/g, hours: OPEN_HOURS.slice() },
  { regex: /(白天)/g, hours: [10, 11, 12, 13, 14, 15, 16, 17] },
  { regex: /(上午)/g, hours: [10, 11] },
  { regex: /(中午)/g, hours: [12, 13] },
  { regex: /(下午)/g, hours: [14, 15, 16, 17] },
  { regex: /(傍晚)/g, hours: [17, 18] },
  { regex: /(晚上|晚间|夜里)/g, hours: [18, 19, 20, 21, 22] }
];

const emptyState = () => ({
  messages: [],
  submissions: {},
  todos: [],
  updatedAt: 0
});

const state = normalizeState(loadLocalState());

const memberSelect = document.getElementById("member-select");
const messageInput = document.getElementById("message-input");
const chatMessages = document.getElementById("chat-messages");
const summaryContent = document.getElementById("summary-content");
const statusContent = document.getElementById("status-content");
const composerForm = document.getElementById("composer-form");
const voiceButton = document.getElementById("voice-button");
const voiceSupport = document.getElementById("voice-support");
const resetButton = document.getElementById("reset-button");
const todoForm = document.getElementById("todo-form");
const todoTimeInput = document.getElementById("todo-time");
const todoTextInput = document.getElementById("todo-text");
const todoStatus = document.getElementById("todo-status");
const todoList = document.getElementById("todo-list");

let speechRecognition = null;
let isRecording = false;
let isSubmitting = false;
let remoteSyncTimer = null;

bootstrap().catch((error) => {
  console.error("Jamly bootstrap failed:", error);
});

async function bootstrap() {
  renderAll();
  setupVoiceRecognition();

  composerForm.addEventListener("submit", handleSubmit);
  resetButton.addEventListener("click", resetState);
  todoForm.addEventListener("submit", handleTodoSubmit);

  document.querySelectorAll("[data-example]").forEach((button) => {
    button.addEventListener("click", () => {
      messageInput.value = button.dataset.example;
      messageInput.focus();
    });
  });

  await syncStateFromServer({ allowUploadLocal: true, silent: false });

  window.addEventListener("focus", () => {
    syncStateFromServer({ allowUploadLocal: false, silent: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncStateFromServer({ allowUploadLocal: false, silent: true });
    }
  });

  remoteSyncTimer = window.setInterval(() => {
    syncStateFromServer({ allowUploadLocal: false, silent: true });
  }, REMOTE_SYNC_INTERVAL);
}

async function handleSubmit(event) {
  event.preventDefault();
  const rawText = messageInput.value.trim();
  if (!rawText) {
    setSupportText("请先输入一句话，再提交。");
    return;
  }

  await submitAvailability(rawText);
}

async function submitAvailability(rawText) {
  if (isSubmitting) {
    return;
  }

  const member = memberSelect.value;
  isSubmitting = true;
  setComposerState(true);
  setSupportText("正在解析这句话...");

  try {
    const parsed = await parseAvailabilitySmart(rawText);
    const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });
    const submission = {
      rawText,
      parsed,
      timestamp
    };
    const userMessage = { role: "user", member, text: rawText, timestamp };
    const botMessage = { role: "bot", member, text: buildBotReply(member, parsed), timestamp };

    state.submissions[member] = submission;
    state.messages.push(userMessage, botMessage);
    state.updatedAt = Date.now();
    saveLocalState(state);
    renderAll();
    messageInput.value = "";

    try {
      const remoteState = await mutateRemoteState({
        action: "setSubmission",
        member,
        submission,
        userMessage,
        botMessage
      });
      mergeIncomingState(remoteState);
      setSupportText("已同步到共享空间，手机和电脑会看到同一份结果。");
    } catch (error) {
      console.warn("Remote submission sync failed:", error);
      setSupportText("本次提交已保存在当前设备；共享同步暂时失败。");
    }
  } catch (error) {
    setSupportText(`提交失败：${error.message || "请稍后再试"}`);
  } finally {
    isSubmitting = false;
    setComposerState(false);
  }
}

async function handleTodoSubmit(event) {
  event.preventDefault();
  const time = todoTimeInput.value;
  const text = todoTextInput.value.trim();

  if (!time || !text) {
    todoStatus.textContent = "把时间和事项都填上，再新增。";
    return;
  }

  const todo = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time,
    text
  };

  state.todos.push(todo);
  state.updatedAt = Date.now();
  saveLocalState(state);
  renderTodos();
  todoForm.reset();

  try {
    const remoteState = await mutateRemoteState({ action: "addTodo", todo });
    mergeIncomingState(remoteState);
    todoStatus.textContent = "事项已加入清单，并同步到共享空间。";
  } catch (error) {
    console.warn("Remote todo sync failed:", error);
    todoStatus.textContent = "事项已保存在当前设备，但共享同步暂时失败。";
  }
}

async function resetState() {
  if (speechRecognition && isRecording) {
    speechRecognition.stop();
  }

  const next = emptyState();
  overwriteState(next);
  setSupportText("当前设备里的数据已清空。");
  todoStatus.textContent = "";

  try {
    const remoteState = await mutateRemoteState({ action: "reset" });
    mergeIncomingState(remoteState);
    setSupportText("共享空间也已经一起清空。");
  } catch (error) {
    console.warn("Remote reset failed:", error);
    setSupportText("当前设备已清空，但共享空间暂时没有同步成功。");
  }
}

function renderAll() {
  renderChat();
  renderSummary();
  renderStatus();
  renderTodos();
}

function renderChat() {
  const intro = `
    <div class="message bot">
      你好，我是 Jamly。你像在微信群里一样直接说这周什么时候有空就行，我会帮你整理成统一的时间段。
      <small>系统消息</small>
    </div>
  `;

  const items = state.messages.map((message) => {
    const meta = message.role === "user"
      ? `${message.member} · ${message.timestamp}`
      : `Jamly · ${message.timestamp}`;

    return `
      <div class="message ${message.role}">
        ${escapeHtml(message.text).replace(/\n/g, "<br>")}
        <small>${meta}</small>
      </div>
    `;
  });

  chatMessages.innerHTML = intro + items.join("");
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderSummary() {
  const completedMembers = MEMBERS.filter((member) => state.submissions[member]);
  const common = findCommonSlots();
  const best = findBestSlots();

  if (!completedMembers.length) {
    summaryContent.innerHTML = `<p class="empty-copy">还没有人提交本周时间。先发一句话试试吧。</p>`;
    return;
  }

  const blocks = [];
  if (completedMembers.length === MEMBERS.length) {
    if (common.length) {
      blocks.push(renderSlotCard("全员可用时间", "以下是六个人都能到的排练时间。", common));
    } else {
      blocks.push(`
        <div class="slot-item">
          <div class="slot-title">全员可用时间</div>
          <div class="slot-meta">目前没有出现六个人同时都有空的时间段。</div>
        </div>
      `);
    }
  } else {
    blocks.push(`
      <div class="slot-item">
        <div class="slot-title">全员可用时间</div>
        <div class="slot-meta">目前已收到 ${completedMembers.length}/6 位成员的提交，等全部提交后再显示真正的全员交集。</div>
      </div>
    `);
  }

  if (best.length) {
    blocks.push(renderSlotCard(`当前次优时间（${best[0].count} 人可用）`, "如果暂时凑不齐全员，可以先参考这组时间。", best.map((item) => item.slot)));
  } else {
    blocks.push(`
      <div class="slot-item">
        <div class="slot-title">当前次优时间</div>
        <div class="slot-meta">还没有足够的数据来生成推荐时间。</div>
      </div>
    `);
  }

  summaryContent.innerHTML = blocks.join("");
}

function renderStatus() {
  statusContent.innerHTML = MEMBERS.map((member) => {
    const submission = state.submissions[member];
    const done = Boolean(submission);
    const copy = done
      ? escapeHtml(submission.parsed.summary || "已完成解析")
      : "还没有提交本周时间。";

    return `
      <div class="status-card ${done ? "done" : "pending"}">
        <div class="pill ${done ? "done" : "pending"}">${done ? "已提交" : "未提交"}</div>
        <div class="status-name">${member}</div>
        <div class="status-meta">${copy}</div>
      </div>
    `;
  }).join("");
}

function renderTodos() {
  const todos = [...state.todos].sort((a, b) => a.time.localeCompare(b.time));
  if (!todos.length) {
    todoList.innerHTML = `<p class="empty-copy">还没有乐队事项。你可以先记一条最近的排练或演出安排。</p>`;
    return;
  }

  todoList.innerHTML = todos.map((item) => `
    <div class="todo-item">
      <div class="todo-time">${formatTodoTime(item.time)}</div>
      <div class="todo-text">${escapeHtml(item.text)}</div>
    </div>
  `).join("");
}

function renderSlotCard(title, subtitle, slots) {
  const lines = formatSlotsByDay(slots);
  return `
    <div class="slot-item">
      <div class="slot-title">${title}</div>
      <div class="slot-meta">${subtitle}</div>
      <div class="slot-meta">${lines.length ? lines.join("<br>") : "暂无"}</div>
    </div>
  `;
}

function formatSlotsByDay(slots) {
  const groups = groupConsecutiveSlots(sanitizeSlots(slots));
  const perDay = new Map();

  groups.forEach((group) => {
    const line = `${pad(group.startHour)}:00~${pad(group.endHour)}:00`;
    const items = perDay.get(group.day) || [];
    items.push(line);
    perDay.set(group.day, items);
  });

  return WEEKDAYS.map((weekday, day) => {
    const items = perDay.get(day);
    return items?.length ? `${weekday} ${items.join(",")}` : "";
  }).filter(Boolean);
}

async function parseAvailabilitySmart(rawText) {
  try {
    const response = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText })
    });

    if (response.ok) {
      const data = await response.json();
      const availableSlots = sanitizeSlots(data.availableSlots || []);
      return {
        availableSlots,
        summary: buildAvailabilitySummary(availableSlots) || data.summary || "暂时没有识别到明确可用时间。"
      };
    }
  } catch (error) {
    console.warn("Remote parse failed, fallback to local parser:", error);
  }

  return parseAvailability(rawText);
}

function parseAvailability(rawText) {
  const text = normalizeText(rawText);
  if (/(这周都可以|这周都行|整周都可以|整周都行|我这周都可以|我这周都有空)/.test(text)) {
    const availableSlots = buildAllWeekSlots();
    return {
      availableSlots,
      summary: buildAvailabilitySummary(availableSlots)
    };
  }

  const entries = buildDayEntries(text);
  const slots = [];

  entries.forEach((entry) => {
    entry.hours.forEach((hour) => slots.push(makeSlot(entry.day, hour)));
  });

  const availableSlots = sanitizeSlots(Array.from(new Set(slots)).sort());
  return {
    availableSlots,
    summary: buildAvailabilitySummary(availableSlots) || "暂时没有识别到明确可用时间，你可以补一句更具体的描述。"
  };
}

function buildDayEntries(text) {
  const entries = [];
  const parts = text
    .replace(/[，。；]/g, ",")
    .split(/,|并且|然后|而且|但是/g)
    .map((part) => part.trim())
    .filter(Boolean);

  parts.forEach((part) => {
    const days = extractDays(part);
    if (!days.length) {
      return;
    }

    const decision = parsePartHours(part);
    days.forEach((day) => {
      entries.push({ day, hours: decision.hours });
    });
  });

  return mergeDayEntries(entries);
}

function extractDays(part) {
  const found = new Set();

  Object.entries(dayAliases).forEach(([label, index]) => {
    if (part.includes(label)) {
      found.add(index);
    }
  });

  if (/工作日/.test(part)) {
    [0, 1, 2, 3, 4].forEach((day) => found.add(day));
  }

  if (/周末/.test(part)) {
    [5, 6].forEach((day) => found.add(day));
  }

  return Array.from(found).sort((a, b) => a - b);
}

function parsePartHours(part) {
  const negated = /(不行|没空|有事|不能|不可以|不太行)/.test(part);
  const hours = extractHours(part);

  if (negated) {
    if (!hours.length) {
      return { hours: [] };
    }
    return { hours: OPEN_HOURS.filter((hour) => !hours.includes(hour)) };
  }

  if (!hours.length) {
    return { hours: OPEN_HOURS.slice() };
  }

  return { hours };
}

function extractHours(part) {
  const hours = new Set();

  timeWords.forEach(({ regex, hours: mapped }) => {
    if (regex.test(part)) {
      mapped.forEach((hour) => hours.add(hour));
    }
    regex.lastIndex = 0;
  });

  for (const match of part.matchAll(/(\d{1,2})点(?:以后|之后|后)/g)) {
    const start = normalizeHour(Number(match[1]));
    OPEN_HOURS.filter((hour) => hour >= start).forEach((hour) => hours.add(hour));
  }

  for (const match of part.matchAll(/(\d{1,2})点\s*(?:到|至|\-|~|～)\s*(\d{1,2})点/g)) {
    const start = normalizeHour(Number(match[1]));
    const end = normalizeHour(Number(match[2]));
    for (let hour = start; hour < end; hour += 1) {
      if (hour >= 10 && hour <= 22) {
        hours.add(hour);
      }
    }
  }

  const exactMatches = Array.from(part.matchAll(/(\d{1,2})点/g), (match) => normalizeHour(Number(match[1])));
  if (exactMatches.length === 1 && hours.size === 0) {
    const exact = exactMatches[0];
    if (exact >= 10 && exact <= 22) {
      hours.add(exact);
      if (exact + 1 <= 22) {
        hours.add(exact + 1);
      }
    }
  }

  return Array.from(hours)
    .filter((hour) => hour >= 10 && hour <= 22)
    .sort((a, b) => a - b);
}

function normalizeHour(hour) {
  if (hour >= 0 && hour <= 7) {
    return hour + 12;
  }
  return hour;
}

function mergeDayEntries(entries) {
  const merged = new Map();
  entries.forEach((entry) => {
    const existing = merged.get(entry.day) || new Set();
    entry.hours.forEach((hour) => existing.add(hour));
    merged.set(entry.day, existing);
  });

  return Array.from(merged.entries())
    .map(([day, hours]) => ({
      day,
      hours: Array.from(hours).sort((a, b) => a - b)
    }))
    .sort((a, b) => a.day - b.day);
}

function findCommonSlots() {
  const completed = MEMBERS.filter((member) => state.submissions[member]);
  if (completed.length !== MEMBERS.length) {
    return [];
  }

  const submitted = completed.map((member) => state.submissions[member].parsed.availableSlots || []);
  return sanitizeSlots(submitted.reduce((acc, slots) => acc.filter((slot) => slots.includes(slot))));
}

function findBestSlots() {
  const counter = new Map();

  MEMBERS.forEach((member) => {
    const slots = sanitizeSlots(state.submissions[member]?.parsed.availableSlots || []);
    slots.forEach((slot) => {
      counter.set(slot, (counter.get(slot) || 0) + 1);
    });
  });

  if (!counter.size) {
    return [];
  }

  const bestCount = Math.max(...counter.values());
  return Array.from(counter.entries())
    .filter(([, count]) => count === bestCount)
    .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
    .map(([slot, count]) => ({ slot, count }));
}

function buildBotReply(member, parsed) {
  if (!parsed.availableSlots.length) {
    return `${member}，我先收到了你的表达，但这次还没完全听懂具体时间。你可以补一句更具体的，比如“周三晚上可以”。`;
  }

  return `${member}，已记录。当前我理解到的可用时间是：${parsed.summary}。如果不对，你可以直接再发一句覆盖这次提交。`;
}

function buildAvailabilitySummary(slots) {
  const lines = formatSlotsByDay(slots);
  return lines.join("；");
}

function buildAllWeekSlots() {
  const slots = [];
  for (let day = 0; day < 7; day += 1) {
    OPEN_HOURS.forEach((hour) => slots.push(makeSlot(day, hour)));
  }
  return slots;
}

function sanitizeSlots(slots) {
  return Array.from(new Set((slots || []).filter((slot) => {
    const parsed = splitSlot(slot);
    return Number.isInteger(parsed.day) && Number.isInteger(parsed.hour) && parsed.day >= 0 && parsed.day <= 6 && parsed.hour >= 10 && parsed.hour <= 22;
  }))).sort((a, b) => {
    const left = splitSlot(a);
    const right = splitSlot(b);
    return (left.day - right.day) || (left.hour - right.hour);
  });
}

function groupConsecutiveSlots(slots) {
  if (!slots.length) {
    return [];
  }

  const parsed = slots.map(splitSlot).sort((a, b) => (a.day - b.day) || (a.hour - b.hour));
  const groups = [];
  let current = {
    day: parsed[0].day,
    startHour: parsed[0].hour,
    endHour: parsed[0].hour + 1
  };

  for (let index = 1; index < parsed.length; index += 1) {
    const item = parsed[index];
    if (item.day === current.day && item.hour === current.endHour) {
      current.endHour += 1;
    } else {
      groups.push(current);
      current = {
        day: item.day,
        startHour: item.hour,
        endHour: item.hour + 1
      };
    }
  }

  groups.push(current);
  return groups;
}

function setupVoiceRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setSupportText("当前浏览器不支持语音识别，建议用 Chrome 或 Edge 测试。");
    voiceButton.disabled = true;
    return;
  }

  speechRecognition = new Recognition();
  speechRecognition.lang = "zh-CN";
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;

  speechRecognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join("")
      .trim();

    if (transcript) {
      messageInput.value = transcript;
      setSupportText("已转成文字，结束后会自动提交。");
    }
  };

  speechRecognition.onerror = () => {
    isRecording = false;
    voiceButton.classList.remove("recording");
    voiceButton.textContent = "点击开始说话";
    setSupportText("语音识别失败了，你可以再试一次，或者直接手动输入文字。");
  };

  speechRecognition.onend = async () => {
    const shouldSubmit = isRecording;
    isRecording = false;
    voiceButton.classList.remove("recording");
    voiceButton.textContent = "点击开始说话";

    if (!shouldSubmit) {
      return;
    }

    const transcript = messageInput.value.trim();
    if (!transcript) {
      setSupportText("没有识别到文字，再试一次吧。");
      return;
    }

    setSupportText("识别完成，正在自动提交...");
    await submitAvailability(transcript);
  };

  voiceButton.addEventListener("click", () => {
    if (isSubmitting) {
      return;
    }
    if (isRecording) {
      stopVoiceRecognition();
      return;
    }
    startVoiceRecognition();
  });
}

function startVoiceRecognition() {
  if (!speechRecognition || isRecording || isSubmitting) {
    return;
  }

  try {
    isRecording = true;
    messageInput.value = "";
    voiceButton.classList.add("recording");
    voiceButton.textContent = "点击结束并发送";
    setSupportText("正在识别语音，说完后再点一次按钮发送。");
    speechRecognition.start();
  } catch (error) {
    isRecording = false;
    voiceButton.classList.remove("recording");
    voiceButton.textContent = "点击开始说话";
    setSupportText("无法开始语音识别，请检查浏览器权限后再试。");
  }
}

function stopVoiceRecognition() {
  if (!speechRecognition || !isRecording) {
    return;
  }
  setSupportText("已结束语音，正在整理文字...");
  speechRecognition.stop();
}

function setComposerState(disabled) {
  messageInput.disabled = disabled;
  voiceButton.disabled = disabled;
}

function setSupportText(text) {
  voiceSupport.textContent = text;
}

function formatTodoTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

async function syncStateFromServer({ allowUploadLocal, silent }) {
  try {
    const remoteState = await fetchRemoteState();
    if (!remoteState) {
      if (allowUploadLocal && hasMeaningfulData(state)) {
        const saved = await mutateRemoteState({ action: "replaceState", state });
        mergeIncomingState(saved);
      }
      return;
    }

    if (allowUploadLocal && hasMeaningfulData(state) && state.updatedAt > (remoteState.updatedAt || 0)) {
      const saved = await mutateRemoteState({ action: "replaceState", state });
      mergeIncomingState(saved);
      return;
    }

    mergeIncomingState(remoteState);
  } catch (error) {
    console.warn("Remote sync failed:", error);
    if (!silent) {
      setSupportText("共享同步暂时不可用，当前先继续使用本地数据。");
    }
  }
}

async function fetchRemoteState() {
  const response = await fetch("/api/state", {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(await response.text() || "Failed to fetch shared state");
  }

  return normalizeState(await response.json());
}

async function mutateRemoteState(payload) {
  const response = await fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await response.text() || "Shared state update failed");
  }

  return normalizeState(await response.json());
}

function mergeIncomingState(nextState) {
  const normalized = normalizeState(nextState);
  if ((normalized.updatedAt || 0) < (state.updatedAt || 0)) {
    return;
  }
  overwriteState(normalized);
}

function overwriteState(nextState) {
  const normalized = normalizeState(nextState);
  state.messages = normalized.messages;
  state.submissions = normalized.submissions;
  state.todos = normalized.todos;
  state.updatedAt = normalized.updatedAt;
  saveLocalState(state);
  renderAll();
}

function normalizeState(raw) {
  const base = emptyState();
  const next = { ...base, ...(raw || {}) };

  next.messages = Array.isArray(next.messages)
    ? next.messages.filter(Boolean).map((message) => ({
      role: message.role === "bot" ? "bot" : "user",
      member: MEMBERS.includes(message.member) ? message.member : MEMBERS[0],
      text: String(message.text || ""),
      timestamp: String(message.timestamp || "")
    }))
    : [];

  next.submissions = MEMBERS.reduce((acc, member) => {
    const submission = next.submissions?.[member];
    if (!submission) {
      return acc;
    }

    const availableSlots = sanitizeSlots(submission.parsed?.availableSlots || []);
    acc[member] = {
      rawText: String(submission.rawText || ""),
      parsed: {
        availableSlots,
        summary: buildAvailabilitySummary(availableSlots) || String(submission.parsed?.summary || "暂时没有识别到明确可用时间。")
      },
      timestamp: String(submission.timestamp || "")
    };
    return acc;
  }, {});

  next.todos = Array.isArray(next.todos)
    ? next.todos
      .filter(Boolean)
      .map((item) => ({
        id: String(item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        time: String(item.time || ""),
        text: String(item.text || "")
      }))
      .filter((item) => item.time && item.text)
    : [];

  next.updatedAt = Number(next.updatedAt || 0);
  return next;
}

function hasMeaningfulData(targetState) {
  return Boolean(targetState.messages.length || Object.keys(targetState.submissions).length || targetState.todos.length);
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : emptyState();
  } catch (error) {
    return emptyState();
  }
}

function saveLocalState(targetState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(targetState));
}

function makeSlot(day, hour) {
  return `${day}-${hour}`;
}

function splitSlot(slot) {
  const [day, hour] = String(slot).split("-").map(Number);
  return { day, hour };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeText(text) {
  return String(text)
    .replace(/\s+/g, "")
    .replace(/OK|ok|Ok/g, "可以");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
