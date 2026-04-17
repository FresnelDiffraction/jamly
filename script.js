const STORAGE_KEY = "jamly-app-v1";
const MEMBERS = ["cold", "david", "圈", "星", "小安", "afai"];
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const ALL_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

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
  "星期日": 6,
  "星期天": 6,
  "礼拜天": 6,
  "礼拜日": 6,
  "周天": 6
};

const timeWords = [
  { regex: /(凌晨|早上)/g, hours: [6, 7, 8, 9] },
  { regex: /(上午)/g, hours: [9, 10, 11] },
  { regex: /(中午)/g, hours: [12, 13] },
  { regex: /(下午)/g, hours: [14, 15, 16, 17] },
  { regex: /(傍晚)/g, hours: [17, 18] },
  { regex: /(晚上|晚间|夜里)/g, hours: [18, 19, 20, 21, 22] },
  { regex: /(全天|整天|都可以|都行|都有空|全都可以)/g, hours: ALL_HOURS.slice() }
];

const state = loadState();

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

bootstrap();

function bootstrap() {
  renderChat();
  renderSummary();
  renderStatus();
  renderTodos();
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
}

async function handleSubmit(event) {
  event.preventDefault();
  const rawText = messageInput.value.trim();
  if (!rawText) {
    voiceSupport.textContent = "先输入一句话，再提交。";
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
  voiceSupport.textContent = "正在解析这句话...";

  try {
    const parsed = await parseAvailabilitySmart(rawText);
    const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });

    state.submissions[member] = { rawText, parsed, timestamp };
    state.messages.push({ role: "user", member, text: rawText, timestamp });
    state.messages.push({ role: "bot", member, text: buildBotReply(member, parsed), timestamp });

    saveState();
    messageInput.value = "";
    voiceSupport.textContent = "";
    renderChat();
    renderSummary();
    renderStatus();
  } catch (error) {
    voiceSupport.textContent = `提交失败：${error.message || "请稍后再试"}`;
  } finally {
    setComposerState(false);
    isSubmitting = false;
  }
}

function renderChat() {
  const intro = `
    <div class="message bot">
      你好，我是 Jamly。你只要像在群里一样说话就行，例如“这周都可以”“周三晚上和周六下午有空”“工作日白天不行”。我会尝试把你的表达整理成可汇总的时间段。
      <small>系统消息</small>
    </div>
  `;

  const items = state.messages.map((message) => {
    const meta = message.role === "user" ? `${message.member} · ${message.timestamp}` : `Jamly · ${message.timestamp}`;
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
  if (!completedMembers.length) {
    summaryContent.innerHTML = `<p class="empty-copy">还没有提交内容。你可以先用聊天框试几句自然表达。</p>`;
    return;
  }

  const common = findCommonSlots();
  const best = findBestSlots();
  const completedCount = completedMembers.length;

  let html = "";
  if (completedCount === MEMBERS.length && common.length) {
    html += renderSlotCard("全员都可以", "目前六个人交集中的时间块", common);
  } else if (completedCount === MEMBERS.length) {
    html += `<div class="slot-item"><div class="slot-title">全员都可以</div><div class="slot-meta">当前还没有出现六个人同时都有空的小时段。</div></div>`;
  } else {
    html += `<div class="slot-item"><div class="slot-title">全员交集待计算</div><div class="slot-meta">目前只收到 ${completedCount}/6 位成员的提交，等六个人都提交后再显示真正的全员交集。</div></div>`;
  }

  html += renderBestCard(best, completedCount);
  summaryContent.innerHTML = html;
}

function renderStatus() {
  statusContent.innerHTML = MEMBERS.map((member) => {
    const submission = state.submissions[member];
    const done = Boolean(submission);
    return `
      <div class="status-card ${done ? "done" : "pending"}">
        <div class="pill ${done ? "done" : "pending"}">${done ? "已提交" : "未提交"}</div>
        <div class="status-name">${member}</div>
        <div class="status-meta">${done ? `解析结果：${escapeHtml(submission.parsed.summary)}` : "还没有提交本周时间。"}</div>
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
  const grouped = groupConsecutiveSlots(slots);
  return `<div class="slot-item"><div class="slot-title">${title}</div><div class="slot-meta">${subtitle}</div><div class="slot-meta">${grouped.length ? grouped.map(formatRange).join("；") : "暂无"}</div></div>`;
}

function renderBestCard(best, completedCount) {
  if (!best.length) {
    return `<div class="slot-item"><div class="slot-title">次优时间</div><div class="slot-meta">还没有足够数据来生成推荐时间。</div></div>`;
  }

  const grouped = groupConsecutiveSlots(best.map((item) => item.slot));
  const supporterCount = best[0].count;
  return `<div class="slot-item"><div class="slot-title">次优时间</div><div class="slot-meta">基于目前已提交的 ${completedCount} 位成员，当前最多有 ${supporterCount} 位成员同时可用。</div><div class="slot-meta">${grouped.map(formatRange).join("；")}</div></div>`;
}

async function parseAvailabilitySmart(rawText) {
  try {
    const response = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText })
    });

    if (response.ok) {
      return await response.json();
    }
  } catch (error) {}

  return parseAvailability(rawText);
}

function parseAvailability(rawText) {
  const text = normalizeText(rawText);
  if (/(这周都可以|这周都行|整周都可以|整周都行|我这周都可以|我这周都有空)/.test(text)) {
    return { availableSlots: buildAllWeekSlots(), summary: "识别为整周都可用" };
  }

  const entries = buildDayEntries(text);
  const slots = [];
  entries.forEach((entry) => {
    if (entry.mode === "all") {
      ALL_HOURS.forEach((hour) => slots.push(makeSlot(entry.day, hour)));
      return;
    }
    entry.hours.forEach((hour) => slots.push(makeSlot(entry.day, hour)));
  });

  const availableSlots = Array.from(new Set(slots)).sort();
  if (!availableSlots.length) {
    return { availableSlots: [], summary: "暂时没识别到明确时间，你可以补一句更具体的描述" };
  }

  return { availableSlots, summary: groupConsecutiveSlots(availableSlots).map(formatRange).join("；") };
}

function buildDayEntries(text) {
  const entries = [];
  const parts = text.replace(/[，。；]/g, ",").split(/,|并且|然后|而且/g).map((part) => part.trim()).filter(Boolean);
  parts.forEach((part) => {
    const days = extractDays(part);
    if (!days.length) {
      return;
    }
    const decision = parsePartHours(part);
    days.forEach((day) => entries.push({ day, mode: decision.mode, hours: decision.hours }));
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
    [0, 1, 2, 3, 4].forEach((index) => found.add(index));
  }
  if (/周末/.test(part)) {
    [5, 6].forEach((index) => found.add(index));
  }
  return Array.from(found);
}

function parsePartHours(part) {
  if (/(全天|整天|都可以|都行|都有空)/.test(part) && !/(不行|没空|有事|不能)/.test(part)) {
    return { mode: "all", hours: [] };
  }
  const hours = extractHours(part);
  const negated = /(不行|没空|有事|不能)/.test(part);
  if (negated) {
    return { mode: "hours", hours: ALL_HOURS.filter((hour) => !hours.includes(hour)) };
  }
  if (!hours.length) {
    return { mode: "hours", hours: [18, 19, 20, 21] };
  }
  return { mode: "hours", hours };
}

function extractHours(part) {
  const hours = new Set();
  timeWords.forEach(({ regex, hours: mapped }) => {
    if (regex.test(part)) {
      mapped.forEach((hour) => hours.add(hour));
    }
    regex.lastIndex = 0;
  });

  for (const match of part.matchAll(/(\d{1,2})点(以后|之后|后)/g)) {
    const start = normalizeHour(Number(match[1]));
    for (let hour = start; hour <= 23; hour += 1) {
      hours.add(hour);
    }
  }

  for (const match of part.matchAll(/(\d{1,2})点(?:到|至|-|—)(\d{1,2})点/g)) {
    const start = normalizeHour(Number(match[1]));
    const end = normalizeHour(Number(match[2]));
    for (let hour = start; hour < end; hour += 1) {
      hours.add(hour);
    }
  }

  const exactMatches = Array.from(part.matchAll(/(\d{1,2})点/g), (match) => normalizeHour(Number(match[1])));
  if (exactMatches.length === 1 && hours.size === 0) {
    const exact = exactMatches[0];
    [exact, Math.min(exact + 1, 23)].forEach((hour) => hours.add(hour));
  }

  return Array.from(hours).filter((hour) => hour >= 0 && hour <= 23).sort((a, b) => a - b);
}

function normalizeHour(hour) {
  return hour >= 0 && hour <= 7 ? hour + 12 : hour;
}

function mergeDayEntries(entries) {
  const merged = new Map();
  entries.forEach((entry) => {
    const existing = merged.get(entry.day) || new Set();
    if (entry.mode === "all") {
      ALL_HOURS.forEach((hour) => existing.add(hour));
    } else {
      entry.hours.forEach((hour) => existing.add(hour));
    }
    merged.set(entry.day, existing);
  });
  return Array.from(merged.entries()).map(([day, hours]) => ({ day, mode: "hours", hours: Array.from(hours).sort((a, b) => a - b) }));
}

function findCommonSlots() {
  const submitted = MEMBERS.map((member) => state.submissions[member]?.parsed.availableSlots || []);
  const completed = MEMBERS.filter((member) => state.submissions[member]);
  if (completed.length !== MEMBERS.length) {
    return [];
  }
  return submitted.reduce((acc, slots) => acc.filter((slot) => slots.includes(slot)));
}

function findBestSlots() {
  const counter = new Map();
  MEMBERS.forEach((member) => {
    const slots = state.submissions[member]?.parsed.availableSlots || [];
    slots.forEach((slot) => counter.set(slot, (counter.get(slot) || 0) + 1));
  });
  if (!counter.size) {
    return [];
  }
  const bestCount = Math.max(...counter.values());
  return Array.from(counter.entries()).filter(([, count]) => count === bestCount).sort((a, b) => a[0].localeCompare(b[0], "zh-CN")).map(([slot, count]) => ({ slot, count }));
}

function buildBotReply(member, parsed) {
  if (!parsed.availableSlots.length) {
    return `${member}，我先收到了你的表达，但这次还没完全听懂具体时间。你可以补一句更具体的，比如“周三晚上可以”。`;
  }
  return `${member}，已记录。当前我理解到的可用时间是：${parsed.summary}。如果不对，你可以直接再发一句覆盖这次提交。`;
}

function loadState() {
  const fallback = { messages: [], submissions: {}, todos: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch (error) {
    return fallback;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function resetState() {
  localStorage.removeItem(STORAGE_KEY);
  state.messages = [];
  state.submissions = {};
  state.todos = [];
  renderChat();
  renderSummary();
  renderStatus();
  renderTodos();
  voiceSupport.textContent = "本地测试数据已清空。";
  setComposerState(false);
  if (speechRecognition && isRecording) {
    speechRecognition.stop();
  }
  isRecording = false;
  isSubmitting = false;
}

function handleTodoSubmit(event) {
  event.preventDefault();
  const time = todoTimeInput.value;
  const text = todoTextInput.value.trim();
  if (!time || !text) {
    todoStatus.textContent = "把时间和事项都填上，再新增。";
    return;
  }
  state.todos.push({ id: `${Date.now()}`, time, text });
  saveState();
  renderTodos();
  todoForm.reset();
  todoStatus.textContent = "事项已加入清单。";
}

function formatTodoTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function setComposerState(disabled) {
  messageInput.disabled = disabled;
  voiceButton.disabled = disabled;
}

function setupVoiceRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    voiceSupport.textContent = "当前浏览器不支持语音识别，建议用 Chrome 或 Edge 测试。";
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
      voiceSupport.textContent = "已转成文字，结束后会自动提交。";
    }
  };

  speechRecognition.onerror = () => {
    isRecording = false;
    voiceButton.classList.remove("recording");
    voiceButton.textContent = "点击开始说话";
    voiceSupport.textContent = "语音识别失败，你可以再试一次，或直接手动输入文字。";
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
      voiceSupport.textContent = "没有识别到文字，再试一次吧。";
      return;
    }

    voiceSupport.textContent = "识别完成，正在自动提交...";
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
  if (isRecording || isSubmitting || !speechRecognition) {
    return;
  }

  try {
    isRecording = true;
    messageInput.value = "";
    voiceButton.classList.add("recording");
    voiceButton.textContent = "点击结束并发送";
    voiceSupport.textContent = "正在识别语音，说完后再点一次按钮发送。";
    speechRecognition.start();
  } catch (error) {
    isRecording = false;
    voiceButton.classList.remove("recording");
    voiceButton.textContent = "点击开始说话";
    voiceSupport.textContent = "无法开始语音识别，请检查浏览器权限后再试。";
  }
}

function stopVoiceRecognition() {
  if (!isRecording || !speechRecognition) {
    return;
  }
  voiceSupport.textContent = "已结束语音，正在整理文字...";
  speechRecognition.stop();
}

function buildAllWeekSlots() {
  const slots = [];
  for (let day = 0; day < 7; day += 1) {
    ALL_HOURS.forEach((hour) => slots.push(makeSlot(day, hour)));
  }
  return slots;
}

function groupConsecutiveSlots(slots) {
  if (!slots.length) {
    return [];
  }
  const parsed = slots.map(splitSlot).sort((a, b) => (a.day - b.day) || (a.hour - b.hour));
  const groups = [];
  let current = { day: parsed[0].day, startHour: parsed[0].hour, endHour: parsed[0].hour + 1 };
  for (let index = 1; index < parsed.length; index += 1) {
    const item = parsed[index];
    if (item.day === current.day && item.hour === current.endHour) {
      current.endHour += 1;
    } else {
      groups.push(current);
      current = { day: item.day, startHour: item.hour, endHour: item.hour + 1 };
    }
  }
  groups.push(current);
  return groups;
}

function formatRange(range) {
  return `${WEEKDAYS[range.day]} ${pad(range.startHour)}:00-${pad(range.endHour)}:00`;
}

function makeSlot(day, hour) {
  return `${day}-${hour}`;
}

function splitSlot(slot) {
  const [day, hour] = slot.split("-").map(Number);
  return { day, hour };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeText(text) {
  return text.replace(/\s+/g, "").replace(/OK|ok|Ok/g, "可以");
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
