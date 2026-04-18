const STORAGE_KEY = "jamly-app-v3";
const MEMBERS = ["cold", "david", "圈", "星", "小安", "afai"];
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const OPEN_HOURS = Array.from({ length: 13 }, (_, index) => index + 10);
const REMOTE_SYNC_INTERVAL = 45000;

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
const clearMemberButton = document.getElementById("clear-member-button");
const todoForm = document.getElementById("todo-form");
const todoTimeInput = document.getElementById("todo-time");
const todoTextInput = document.getElementById("todo-text");
const todoStatus = document.getElementById("todo-status");
const todoList = document.getElementById("todo-list");
const tabsList = document.getElementById("tabs-list");
const tabsBackButton = document.getElementById("tabs-back-button");
const tabsBreadcrumb = document.getElementById("tabs-breadcrumb");

let speechRecognition = null;
let isRecording = false;
let isSubmitting = false;
let remoteSyncTimer = null;
let voiceStopRequested = false;
let currentTabSong = "";

bootstrap().catch((error) => {
  console.error("Jamly bootstrap failed:", error);
});

async function bootstrap() {
  renderAll();
  await renderTabs();
  setupVoiceRecognition();

  composerForm.addEventListener("submit", handleSubmit);
  resetButton.addEventListener("click", resetState);
  clearMemberButton.addEventListener("click", clearCurrentMemberState);
  todoForm.addEventListener("submit", handleTodoSubmit);
  tabsBackButton?.addEventListener("click", () => renderTabs(""));

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
    setSupportText("先输入一句话，再提交。");
    return;
  }

  await submitAvailability(rawText);
}

async function submitAvailability(rawText) {
  if (isSubmitting) {
    return;
  }

  const member = memberSelect.value;
  const previous = state.submissions[member] || null;
  isSubmitting = true;
  setComposerState(true);
  setSupportText("正在更新这位成员的本周草稿状态...");

  try {
    const parsed = await parseAvailabilitySmart(rawText, member, previous);
    const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });
    const submission = {
      rawText,
      draft: parsed.draft,
      parsed: {
        availableSlots: parsed.availableSlots,
        uncertainSlots: parsed.uncertainSlots,
        summary: parsed.summary,
        uncertainSummary: parsed.uncertainSummary,
        needsConfirmation: parsed.needsConfirmation,
        clarificationQuestion: parsed.clarificationQuestion
      },
      timestamp
    };
    const userMessage = { role: "user", member, text: rawText, timestamp };
    const botMessage = {
      role: "bot",
      member,
      text: buildBotReply(member, parsed),
      timestamp
    };

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
      setSupportText(parsed.needsConfirmation
        ? "草稿已同步。你可以继续补一句，系统会在当前理解上做增量更新。"
        : "草稿已同步，手机和电脑现在会看到同一份成员状态。");
    } catch (error) {
      console.warn("Remote submission sync failed:", error);
      setSupportText("本次提交已保存在当前设备，共享同步稍后再试。");
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

  overwriteState(createEmptyState());
  setSupportText("已经清空所有成员当前状态，并开始新的一周。");
  todoStatus.textContent = "";

  try {
    const remoteState = await mutateRemoteState({ action: "reset" });
    mergeIncomingState(remoteState);
    setSupportText("共享空间也已经切换到新的一周。");
  } catch (error) {
    console.warn("Remote reset failed:", error);
    setSupportText("当前设备已经开始新的一周，但共享同步暂时失败。");
  }
}

async function clearCurrentMemberState() {
  const member = memberSelect.value;
  if (!member) {
    return;
  }

  if (speechRecognition && isRecording) {
    speechRecognition.stop();
  }

  delete state.submissions[member];
  state.messages = state.messages.filter((message) => message.member !== member);
  state.updatedAt = Date.now();
  saveLocalState(state);
  renderAll();
  setSupportText(`${member} 的当前草稿状态已从本机清空。`);

  try {
    const remoteState = await mutateRemoteState({ action: "clearMember", member });
    mergeIncomingState(remoteState);
    setSupportText(`${member} 的状态已从共享空间清空，不会影响其他人。`);
  } catch (error) {
    console.warn("Remote member clear failed:", error);
    setSupportText(`${member} 的本地状态已清空，但共享同步暂时失败。`);
  }
}

async function renderTabs(song = currentTabSong) {
  currentTabSong = song;
  if (!tabsList || !tabsBreadcrumb || !tabsBackButton) {
    return;
  }

  tabsBackButton.hidden = !song;
  tabsBreadcrumb.textContent = song ? `曲谱总表 / ${song}` : "曲谱总表";
  tabsList.innerHTML = `<div class="empty-copy">正在读取曲谱...</div>`;

  try {
    const url = song ? `/api/tabs?song=${encodeURIComponent(song)}` : "/api/tabs";
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Tabs fetch failed");
    }

    const data = await response.json();
    if (!song) {
      renderSongList(data.songs || []);
    } else {
      renderSongFiles(song, data.files || []);
    }
  } catch (error) {
    tabsList.innerHTML = `<div class="empty-copy">曲谱暂时读取失败，请稍后再试。</div>`;
  }
}

function renderSongList(songs) {
  if (!songs.length) {
    tabsList.innerHTML = `<div class="empty-copy">还没有上传任何曲谱目录。</div>`;
    return;
  }

  tabsList.innerHTML = songs.map((song) => `
    <button type="button" class="tabs-item tabs-song-button" data-song-name="${escapeHtml(song.name)}">
      <span class="tabs-item-title">${escapeHtml(song.name)}</span>
      <span class="slot-meta">点击查看这首歌的所有文件</span>
    </button>
  `).join("");

  tabsList.querySelectorAll("[data-song-name]").forEach((button) => {
    button.addEventListener("click", () => {
      renderTabs(button.dataset.songName);
    });
  });
}

function renderSongFiles(song, files) {
  if (!files.length) {
    tabsList.innerHTML = `<div class="empty-copy">${escapeHtml(song)} 下面还没有文件。</div>`;
    return;
  }

  tabsList.innerHTML = files.map((file) => `
    <a class="tabs-item tabs-file-link" href="${encodeURI(file.href)}" target="_blank" rel="noreferrer">
      <span class="tabs-item-title">${escapeHtml(file.name)}</span>
      <span class="slot-meta">点击打开或下载</span>
    </a>
  `).join("");
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
      你好，我是 Jamly。你像在微信群里一样直接说这周什么时候有空就行，例如：我周五晚上约了朋友吃饭，周一下午2点到4点有课，其他时候都可以。我会先维护你的本周草稿状态，再帮你整理成统一的时间段；如果有“可能有事”的时间，我也会把它记成待定。
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
  if (!completedMembers.length) {
    summaryContent.innerHTML = `<p class="empty-copy">还没有人提交本周时间。先发一句话试试吧。</p>`;
    return;
  }

  const blocks = [];
  if (completedMembers.length === MEMBERS.length) {
    const definiteCommon = findCommonSlots();
    const pendingCommon = findPendingCommonSlots();

    blocks.push(renderSlotCard(
      "全员确定可行时间",
      definiteCommon.length
        ? "以下时间每个人都已经明确可以。"
        : "目前还没有出现 6 个人都明确可以的时间段。",
      formatDefiniteLines(definiteCommon)
    ));

    blocks.push(renderSlotCard(
      "全员可行（含待定）",
      pendingCommon.length
        ? "以下时间没有人明确冲突，但带有待定成员标记。"
        : "目前还没有出现带待定标记的全员可行时间。",
      formatPendingLines(pendingCommon)
    ));
  } else {
    blocks.push(`
      <div class="slot-item">
        <div class="slot-title">全员结果待生成</div>
        <div class="slot-meta">目前已收到 ${completedMembers.length}/${MEMBERS.length} 位成员的草稿状态，等所有人都提交后会显示完整的确定结果和待定结果。</div>
      </div>
    `);
  }

  const best = findBestDefiniteSlots();
  const bestPending = findBestPendingSlots();

  blocks.push(renderSlotCard(
    best.length ? `当前次优时间（${best[0].count} 人明确可）` : "当前次优时间",
    best.length ? "如果还没收齐所有人，可以先看当前明确可行度最高的时间。" : "还没有足够的数据生成当前明确可行时间。",
    formatDefiniteLines(best.map((item) => item.slot))
  ));

  blocks.push(renderSlotCard(
    bestPending.length ? `当前次优时间（含待定，${bestPending[0].count} 人非冲突）` : "当前次优时间（含待定）",
    bestPending.length ? "这些时间没有人明确冲突，但其中包含待定成员。" : "还没有带待定标记的推荐时间。",
    formatPendingLines(bestPending)
  ));

  summaryContent.innerHTML = blocks.join("");
}

function renderStatus() {
  statusContent.innerHTML = MEMBERS.map((member) => {
    const submission = state.submissions[member];
    const done = Boolean(submission);
    const waiting = submission?.parsed?.needsConfirmation;
    const summaryParts = [];

    if (!done) {
      summaryParts.push("还没有提交本周时间。");
    } else {
      if (submission.parsed.summary) {
        summaryParts.push(`确定可行：${submission.parsed.summary}`);
      } else {
        summaryParts.push("还没有明确的确定可行时间。");
      }

      if (submission.parsed.uncertainSummary) {
        summaryParts.push(`待定：${submission.parsed.uncertainSummary}`);
      }

      if (submission.parsed.needsConfirmation && submission.parsed.clarificationQuestion) {
        summaryParts.push(`待确认：${submission.parsed.clarificationQuestion}`);
      }
    }

    return `
      <div class="status-card ${done ? "done" : "pending"}">
        <div class="pill ${waiting ? "pending" : done ? "done" : "pending"}">${waiting ? "待确认" : done ? "已提交" : "未提交"}</div>
        <div class="status-name">${member}</div>
        <div class="status-meta">${escapeHtml(summaryParts.join("；"))}</div>
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

function renderSlotCard(title, subtitle, lines) {
  return `
    <div class="slot-item">
      <div class="slot-title">${title}</div>
      <div class="slot-meta">${subtitle}</div>
      <div class="slot-meta">${lines.length ? lines.join("<br>") : "暂无"}</div>
    </div>
  `;
}

function formatDefiniteLines(slots) {
  return formatSlotsByDay(slots);
}

function formatPendingLines(items) {
  if (!items.length) {
    return [];
  }

  const grouped = groupPendingItems(items);
  return WEEKDAYS.map((weekday, day) => {
    const dayItems = grouped
      .filter((item) => item.day === day)
      .map((item) => `${formatRange(item.startHour, item.endHour - 1)}（${item.pendingMembers.join("、")}待定）`);
    return dayItems.length ? `${weekday} ${dayItems.join("，")}` : "";
  }).filter(Boolean);
}

async function parseAvailabilitySmart(rawText, member, previousSubmission) {
  try {
    const response = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: rawText,
        member,
        currentDraft: previousSubmission?.draft || createEmptyDraft(),
        recentMessages: state.messages.filter((message) => message.member === member).slice(-6)
      })
    });

    if (!response.ok) {
      throw new Error(await response.text() || "Parse failed");
    }

    const data = await response.json();
    const draft = normalizeDraft(data.draft || createEmptyDraft());
    const availableSlots = sanitizeSlots(data.availableSlots || []);
    const uncertainSlots = sanitizeSlots(data.uncertainSlots || []);
    return {
      draft,
      availableSlots,
      uncertainSlots,
      summary: buildAvailabilitySummary(availableSlots) || String(data.summary || ""),
      uncertainSummary: buildAvailabilitySummary(uncertainSlots) || String(data.uncertainSummary || ""),
      needsConfirmation: Boolean(data.needsConfirmation),
      clarificationQuestion: String(data.clarificationQuestion || "")
    };
  } catch (error) {
    console.warn("Remote parse failed, fallback to conservative local mode:", error);
    return parseAvailabilityFallback(rawText, previousSubmission?.draft || createEmptyDraft());
  }
}

function parseAvailabilityFallback(rawText, currentDraft) {
  const text = normalizeText(rawText);
  const draft = normalizeDraft(currentDraft);

  if (/(这周都可以|这周所有时间都可以|整周都可以|我这周都可以)/.test(text)) {
    draft.mode = "whole_week_with_exceptions";
    draft.available = createEmptyDayMap();
    draft.unavailable = createEmptyDayMap();
    draft.uncertain = createEmptyDayMap();
    draft.normalizedText = rawText;
    draft.lastIntent = "overwrite";
    draft.needsConfirmation = false;
    draft.clarificationQuestion = "";
  } else {
    draft.normalizedText = rawText;
    draft.lastIntent = "patch";
    draft.needsConfirmation = true;
    draft.clarificationQuestion = "我先收到了这句话，但为了避免理解错，你可以补一句“没说的其他时间都可以”或者直接再说一次完整时间。";
  }

  const availableSlots = computeAvailableSlotsFromDraft(draft);
  const uncertainSlots = dayMapToSlots(draft.uncertain);
  return {
    draft,
    availableSlots,
    uncertainSlots,
    summary: buildAvailabilitySummary(availableSlots),
    uncertainSummary: buildAvailabilitySummary(uncertainSlots),
    needsConfirmation: draft.needsConfirmation,
    clarificationQuestion: draft.clarificationQuestion
  };
}

function findCommonSlots() {
  const completed = MEMBERS.filter((member) => state.submissions[member]);
  if (completed.length !== MEMBERS.length) {
    return [];
  }

  const first = state.submissions[completed[0]].parsed.availableSlots || [];
  return sanitizeSlots(first.filter((slot) => completed.every((member) => state.submissions[member].parsed.availableSlots.includes(slot))));
}

function findPendingCommonSlots() {
  const completed = MEMBERS.filter((member) => state.submissions[member]);
  if (completed.length !== MEMBERS.length) {
    return [];
  }

  const allSlots = buildAllWeekSlots();
  return allSlots.reduce((acc, slot) => {
    const pendingMembers = [];
    let blocked = false;

    completed.forEach((member) => {
      const submission = state.submissions[member];
      const available = submission.parsed.availableSlots.includes(slot);
      const uncertain = submission.parsed.uncertainSlots.includes(slot);
      if (!available && !uncertain) {
        blocked = true;
      } else if (uncertain) {
        pendingMembers.push(member);
      }
    });

    if (!blocked && pendingMembers.length) {
      acc.push({ slot, pendingMembers });
    }
    return acc;
  }, []);
}

function findBestDefiniteSlots() {
  const counter = new Map();

  MEMBERS.forEach((member) => {
    const slots = sanitizeSlots(state.submissions[member]?.parsed?.availableSlots || []);
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

function findBestPendingSlots() {
  const scoreMap = new Map();
  const detailMap = new Map();

  buildAllWeekSlots().forEach((slot) => {
    let score = 0;
    let blocked = false;
    const pendingMembers = [];

    MEMBERS.forEach((member) => {
      const submission = state.submissions[member];
      if (!submission) {
        return;
      }
      if (submission.parsed.availableSlots.includes(slot)) {
        score += 1;
        return;
      }
      if (submission.parsed.uncertainSlots.includes(slot)) {
        score += 1;
        pendingMembers.push(member);
        return;
      }
      blocked = true;
    });

    if (!blocked && pendingMembers.length) {
      scoreMap.set(slot, score);
      detailMap.set(slot, pendingMembers);
    }
  });

  if (!scoreMap.size) {
    return [];
  }

  const bestCount = Math.max(...scoreMap.values());
  return Array.from(scoreMap.entries())
    .filter(([, count]) => count === bestCount)
    .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
    .map(([slot, count]) => ({
      slot,
      count,
      pendingMembers: detailMap.get(slot) || []
    }));
}

function buildBotReply(member, parsed) {
  const chunks = [];

  if (parsed.summary) {
    chunks.push(`当前我理解的确定可行时间是：${parsed.summary}`);
  } else {
    chunks.push("我先记下了这句话，但现在还没有足够明确的确定可行时间。");
  }

  if (parsed.uncertainSummary) {
    chunks.push(`待定时间是：${parsed.uncertainSummary}`);
  }

  if (parsed.needsConfirmation && parsed.clarificationQuestion) {
    chunks.push(`还差一个确认：${parsed.clarificationQuestion}`);
    return `${member}，已暂存。${chunks.join("。")}。`;
  }

  return `${member}，已更新。${chunks.join("。")}。如果不对，你可以继续补一句，我会在当前草稿上继续改。`;
}

function buildAvailabilitySummary(slots) {
  const lines = formatSlotsByDay(slots);
  return lines.join("；");
}

function formatSlotsByDay(slots) {
  const groups = groupConsecutiveSlots(sanitizeSlots(slots));
  const perDay = new Map();

  groups.forEach((group) => {
    const line = formatRange(group.startHour, group.endHour - 1);
    const items = perDay.get(group.day) || [];
    items.push(line);
    perDay.set(group.day, items);
  });

  return WEEKDAYS.map((weekday, day) => {
    const items = perDay.get(day);
    return items?.length ? `${weekday} ${items.join(",")}` : "";
  }).filter(Boolean);
}

function groupPendingItems(items) {
  if (!items.length) {
    return [];
  }

  const sorted = [...items].sort((left, right) => left.slot.localeCompare(right.slot, "zh-CN"));
  const groups = [];

  sorted.forEach((item) => {
    const { day, hour } = splitSlot(item.slot);
    const signature = item.pendingMembers.slice().sort().join("|");
    const current = groups[groups.length - 1];

    if (current && current.day === day && current.endHour === hour && current.signature === signature) {
      current.endHour += 1;
    } else {
      groups.push({
        day,
        startHour: hour,
        endHour: hour + 1,
        pendingMembers: item.pendingMembers.slice().sort(),
        signature
      });
    }
  });

  return groups;
}

function groupConsecutiveSlots(slots) {
  if (!slots.length) {
    return [];
  }

  const parsed = slots.map(splitSlot).sort((left, right) => (left.day - right.day) || (left.hour - right.hour));
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
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;

  speechRecognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join("")
      .trim();

    if (transcript) {
      messageInput.value = transcript;
      setSupportText("正在持续识别，你可以停下来想一会儿，只有你自己点“结束录音”才会结束。");
    }
  };

  speechRecognition.onerror = () => {
    isRecording = false;
    voiceStopRequested = false;
    voiceButton.classList.remove("recording");
    voiceButton.textContent = "点击开始说话";
    setSupportText("语音识别失败了，你可以再试一次，或者直接手动输入文字。");
  };

  speechRecognition.onend = () => {
    const endedByUser = voiceStopRequested;
    isRecording = false;
    voiceStopRequested = false;
    voiceButton.classList.remove("recording");
    voiceButton.textContent = "点击开始说话";

    if (!messageInput.value.trim()) {
      setSupportText("没有识别到文字，再试一次吧。");
      return;
    }

    if (endedByUser) {
      setSupportText("录音已结束，文字已经保留。确认无误后再点发送。");
      return;
    }

    setSupportText("浏览器把这段录音停掉了，但我没有自动提交。你可以继续点开始说话，或者直接点发送。");
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
    voiceStopRequested = false;
    messageInput.value = "";
    voiceButton.classList.add("recording");
    voiceButton.textContent = "点击结束录音";
    setSupportText("正在持续识别，你可以停顿思考；结束时再点一次按钮。");
    speechRecognition.start();
  } catch (error) {
    isRecording = false;
    voiceStopRequested = false;
    voiceButton.classList.remove("recording");
    voiceButton.textContent = "点击开始说话";
    setSupportText("无法开始语音识别，请检查浏览器权限后再试。");
  }
}

function stopVoiceRecognition() {
  if (!speechRecognition || !isRecording) {
    return;
  }
  voiceStopRequested = true;
  setSupportText("已结束录音，正在整理文字...");
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
  state.weekKey = normalized.weekKey;
  state.messages = normalized.messages;
  state.submissions = normalized.submissions;
  state.todos = normalized.todos;
  state.updatedAt = normalized.updatedAt;
  saveLocalState(state);
  renderAll();
}

function createEmptyDayMap() {
  return {
    "0": [],
    "1": [],
    "2": [],
    "3": [],
    "4": [],
    "5": [],
    "6": []
  };
}

function sanitizeHours(hours) {
  return Array.from(new Set((hours || []).filter((hour) => Number.isInteger(hour) && hour >= 10 && hour <= 22))).sort((a, b) => a - b);
}

function normalizeDayMap(dayMap) {
  const next = createEmptyDayMap();
  Object.keys(next).forEach((day) => {
    next[day] = sanitizeHours(dayMap?.[day]);
  });
  return next;
}

function createEmptyDraft() {
  return {
    mode: "unknown",
    normalizedText: "",
    available: createEmptyDayMap(),
    unavailable: createEmptyDayMap(),
    uncertain: createEmptyDayMap(),
    lastIntent: "overwrite",
    needsConfirmation: false,
    clarificationQuestion: ""
  };
}

function createWeekKey(date = new Date()) {
  const current = new Date(date);
  const weekday = current.getDay();
  const diff = weekday === 0 ? -6 : 1 - weekday;
  current.setHours(0, 0, 0, 0);
  current.setDate(current.getDate() + diff);
  return current.toISOString().slice(0, 10);
}

function createEmptyState() {
  return {
    weekKey: createWeekKey(),
    messages: [],
    submissions: {},
    todos: [],
    updatedAt: 0
  };
}

function normalizeDraft(raw) {
  const base = createEmptyDraft();
  return {
    mode: ["unknown", "whole_week_with_exceptions", "explicit_slots_only"].includes(raw?.mode) ? raw.mode : base.mode,
    normalizedText: String(raw?.normalizedText || raw?.normalized_text || ""),
    available: normalizeDayMap(raw?.available),
    unavailable: normalizeDayMap(raw?.unavailable),
    uncertain: normalizeDayMap(raw?.uncertain),
    lastIntent: ["overwrite", "patch", "confirm", "clarify"].includes(raw?.lastIntent || raw?.intent)
      ? (raw.lastIntent || raw.intent)
      : base.lastIntent,
    needsConfirmation: Boolean(raw?.needsConfirmation ?? raw?.needs_confirmation),
    clarificationQuestion: String(raw?.clarificationQuestion || raw?.clarification_question || "")
  };
}

function normalizeSubmission(raw) {
  if (!raw) {
    return null;
  }

  const availableSlots = sanitizeSlots(raw?.parsed?.availableSlots || []);
  const uncertainSlots = sanitizeSlots(raw?.parsed?.uncertainSlots || []);

  return {
    rawText: String(raw.rawText || ""),
    timestamp: String(raw.timestamp || ""),
    draft: normalizeDraft(raw.draft),
    parsed: {
      availableSlots,
      uncertainSlots,
      summary: String(raw?.parsed?.summary || buildAvailabilitySummary(availableSlots)),
      uncertainSummary: String(raw?.parsed?.uncertainSummary || buildAvailabilitySummary(uncertainSlots)),
      needsConfirmation: Boolean(raw?.parsed?.needsConfirmation),
      clarificationQuestion: String(raw?.parsed?.clarificationQuestion || "")
    }
  };
}

function normalizeState(raw) {
  const base = createEmptyState();
  return {
    weekKey: String(raw?.weekKey || base.weekKey),
    messages: Array.isArray(raw?.messages)
      ? raw.messages.filter(Boolean).map((message) => ({
        role: message?.role === "bot" ? "bot" : "user",
        member: MEMBERS.includes(message?.member) ? message.member : MEMBERS[0],
        text: String(message?.text || ""),
        timestamp: String(message?.timestamp || "")
      }))
      : [],
    submissions: MEMBERS.reduce((acc, member) => {
      const submission = normalizeSubmission(raw?.submissions?.[member]);
      if (submission) {
        acc[member] = submission;
      }
      return acc;
    }, {}),
    todos: Array.isArray(raw?.todos)
      ? raw.todos
        .filter(Boolean)
        .map((item) => ({
          id: String(item?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          time: String(item?.time || ""),
          text: String(item?.text || "")
        }))
        .filter((item) => item.time && item.text)
      : [],
    updatedAt: Number(raw?.updatedAt || 0)
  };
}

function hasMeaningfulData(targetState) {
  return Boolean(targetState.messages.length || Object.keys(targetState.submissions).length || targetState.todos.length);
}

function computeAvailableSlotsFromDraft(draft) {
  const available = new Set();
  const unavailable = new Set(dayMapToSlots(draft.unavailable));
  const uncertain = new Set(dayMapToSlots(draft.uncertain));

  if (draft.mode === "whole_week_with_exceptions") {
    for (let day = 0; day < 7; day += 1) {
      OPEN_HOURS.forEach((hour) => {
        const slot = makeSlot(day, hour);
        if (!unavailable.has(slot) && !uncertain.has(slot)) {
          available.add(slot);
        }
      });
    }
  } else {
    dayMapToSlots(draft.available).forEach((slot) => {
      if (!unavailable.has(slot) && !uncertain.has(slot)) {
        available.add(slot);
      }
    });
  }

  return sanitizeSlots(Array.from(available));
}

function buildAllWeekSlots() {
  const slots = [];
  for (let day = 0; day < 7; day += 1) {
    OPEN_HOURS.forEach((hour) => {
      slots.push(makeSlot(day, hour));
    });
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

function dayMapToSlots(dayMap) {
  const slots = [];
  Object.keys(createEmptyDayMap()).forEach((day) => {
    sanitizeHours(dayMap?.[day]).forEach((hour) => {
      slots.push(`${day}-${hour}`);
    });
  });
  return sanitizeSlots(slots);
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : createEmptyState();
  } catch (error) {
    return createEmptyState();
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

function formatRange(start, end) {
  return `${pad(start)}:00~${pad(end + 1)}:00`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeText(text) {
  return String(text).replace(/\s+/g, "").replace(/OK|ok|Ok/g, "可以");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
