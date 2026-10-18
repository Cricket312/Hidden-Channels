(() => {
"use strict";
/* Read-only projections of channel metadata already in Discord's stores. */
function hiddenChannelModel() {
    const types = { 0: "Text", 2: "Voice", 4: "Category", 5: "Announcement", 10: "Announcement thread", 11: "Public thread", 12: "Private thread", 13: "Stage", 14: "Directory", 15: "Forum", 16: "Media" };
    const text = (value, max = 200) => typeof value === "string" ? value.slice(0, max) : "";
    const position = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    function channelsFrom(input, guildId) {
        const found = new Map(), seen = new Set();
        let visited = 0, truncated = false;
        function walk(value, depth) {
            if (!value || typeof value !== "object" || seen.has(value)) return;
            if (++visited > 30000 || depth > 8) { truncated = true; return; }
            seen.add(value);
            if (value.id != null && value.type != null) {
                if (String(value.guild_id || value.guildId || "") === String(guildId)
                    && Object.prototype.hasOwnProperty.call(types, value.type)) found.set(String(value.id), value);
                return;
            }
            if (Object.prototype.toString.call(value) === "[object Map]") { for (const child of value.values()) walk(child, depth + 1); }
            else if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); }
            else { for (const child of Object.values(value)) walk(child, depth + 1); }
        }
        walk(input, 0);
        return { records: Array.from(found.values()), truncated };
    }
    function catalog(input, guildId, canView) {
        const { records, truncated } = channelsFrom(input, guildId);
        const byId = new Map(records.map(c => [String(c.id), c]));
        let unknown = 0;
        const hidden = [];
        for (const channel of records) {
            let result;
            try { result = canView(channel); } catch (_) {}
            if (result !== true && result !== false) { unknown++; continue; }
            if (result) continue;
            const parentId = String(channel.parent_id || channel.parentId || "");
            const parent = byId.get(parentId);
            hidden.push({
                id: String(channel.id), guildId: String(guildId), type: Number(channel.type),
                typeName: types[channel.type], name: text(channel.name) || "Name unavailable",
                topic: text(channel.topic, 6000), parentId,
                category: Number(channel.type) === 4 ? "Categories" : (parent ? text(parent.name) : (parentId ? "Category " + parentId : "Uncategorized")),
                categoryPosition: Number(channel.type) === 4 ? -2 : (parent ? position(parent.position) : -1),
                position: position(channel.position), nsfw: !!(channel.nsfw || channel.nsfw_),
                slowmode: Math.max(0, position(channel.rate_limit_per_user || channel.rateLimitPerUser)),
                bitrate: Math.max(0, position(channel.bitrate)), userLimit: Math.max(0, position(channel.user_limit || channel.userLimit))
            });
        }
        hidden.sort((a, b) => a.categoryPosition - b.categoryPosition || a.category.localeCompare(b.category)
            || a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        return { hidden, cached: records.length, unknown, truncated };
    }
    // Exact low-bit calculation even for decimal permission strings above 2^53.
    function viewBit(value) {
        const digits = String(value == null ? "0" : value);
        if (!/^\d+$/.test(digits)) return false;
        let remainder = 0;
        for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 2048;
        return remainder >= 1024;
    }
    function rules(channel, roles, guildId) {
        const raw = channel?.permissionOverwrites || channel?.permission_overwrites || {};
        const entries = Object.prototype.toString.call(raw) === "[object Map]" ? Array.from(raw.values()) : Object.values(raw);
        const roleMap = Object.prototype.toString.call(roles) === "[object Map]" ? Object.fromEntries(roles) : (Array.isArray(roles) ? Object.fromEntries(roles.map(r => [r.id, r])) : (roles || {}));
        return entries.filter(Boolean).slice(0, 200).map(rule => {
            const allow = viewBit(rule.allow), deny = viewBit(rule.deny), id = String(rule.id || "");
            if (!id || (!allow && !deny)) return null;
            return { id, label: Number(rule.type) === 1 ? "Member " + id : (id === String(guildId) ? "@everyone" : text(roleMap[id]?.name) || "Role " + id), value: allow && deny ? "Conflicting rules" : allow ? "Allow view" : "Deny view" };
        }).filter(Boolean);
    }
    function voiceParticipants(input, channelId, guildId, getUser, getMember) {
        if (!input || typeof input !== "object") return { available: false, people: [], truncated: false };
        const values = Object.prototype.toString.call(input) === "[object Map]" ? Array.from(input.values()) : Object.values(input);
        const people = [], seen = new Set();
        for (const raw of values.slice(0, 2000)) {
            if (!raw || typeof raw !== "object") continue;
            const state = raw.voiceState || raw;
            if (String(state.channelId ?? state.channel_id ?? "") !== String(channelId)) continue;
            if (state.guildId || state.guild_id) {
                if (String(state.guildId || state.guild_id) !== String(guildId)) continue;
            }
            const id = String(state.userId || state.user_id || "");
            if (!id || seen.has(id)) continue;
            seen.add(id);
            let user, member;
            try { user = getUser?.(id); } catch (_) {}
            try { member = getMember?.(guildId, id); } catch (_) {}
            const flags = [];
            if (state.mute === true) flags.push("Server muted");
            else if (state.selfMute === true || state.self_mute === true) flags.push("Muted");
            if (state.deaf === true) flags.push("Server deafened");
            else if (state.selfDeaf === true || state.self_deaf === true) flags.push("Deafened");
            if (state.selfVideo === true || state.self_video === true) flags.push("Camera on");
            if (state.selfStream === true || state.self_stream === true) flags.push("Streaming");
            if (state.suppress === true) flags.push("Audience");
            people.push({ id, name: text(member?.nick) || text(user?.globalName) || text(user?.global_name) || text(user?.username) || "User " + id, flags });
        }
        people.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        return { available: true, people: people.slice(0, 200), truncated: people.length > 200 || values.length > 2000 };
    }
    return { channelsFrom, catalog, rules, voiceParticipants };
}


/* Discord Android 349.9 ChannelListImpl projection. No permission override.
 * Clone display models, preserving their prototypes and the original stores.
 * The native renderer is intercepted before any hidden channel component runs.
 */
function projectHiddenChannels(original, hidden, getRecord) {
    if (!original || !original.categories || !original.noParentCategory
        || typeof original.getRows !== "function" || typeof original.getSections !== "function"
        || typeof original.getChannelFromSectionRow !== "function") return null;
    const clone = value => Object.assign(Object.create(Object.getPrototypeOf(value)), value);
    const projected = clone(original), byParent = new Map();
    const supported = new Set([0, 2, 5, 13, 15, 16]);
    for (const channel of hidden) {
        if (!supported.has(channel.type)) continue;
        const parent = channel.parentId && original.categories[channel.parentId] ? channel.parentId : "";
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(channel);
    }
    function copyCategory(category, additions = []) {
        if (!category || typeof category.getShownChannelIds !== "function" || !category.channels) return category;
        const copy = clone(category);
        copy.guild = projected;
        copy.channels = {};
        for (const [id, row] of Object.entries(category.channels)) {
            copy.channels[id] = clone(row);
            copy.channels[id].category = copy;
        }
        const nativeIds = category.getShownChannelIds().slice();
        const extra = [];
        for (const channel of additions) {
            const record = getRecord(channel.id);
            if (!record || String(record.guild_id || record.guildId) !== String(original.id)) continue;
            const row = copy.channels[channel.id] || { id: channel.id, record, category: copy, position: 0 };
            // Only our renderer consumes these added rows; native voice/text components never mount.
            Object.assign(row, { record, threadIds: [], threadCount: 0, subtitle: null, __hiddenChannelsRow: true });
            copy.channels[channel.id] = row;
            extra.push(channel.id);
        }
        const order = id => {
            const record = copy.channels[id]?.record || {};
            return (Number(record.position) || 0) + ([2, 13].includes(Number(record.type)) ? 10000 : 0);
        };
        const shown = copy.isCollapsed ? nativeIds : [...new Set([...nativeIds, ...extra])].sort((a, b) => order(a) - order(b));
        copy.shownChannelIds = shown;
        copy.getShownChannelIds = () => shown;
        return copy;
    }
    projected.categories = {};
    for (const [id, category] of Object.entries(original.categories)) projected.categories[id] = copyCategory(category, byParent.get(id));
    projected.noParentCategory = copyCategory(original.noParentCategory, byParent.get(""));
    // Clone every category touched by native layout so native position caches stay isolated.
    for (const key of ["favoritesCategory", "recentsCategory", "voiceChannelsCategory"]) projected[key] = copyCategory(original[key]);
    projected.rows = null;
    projected.sections = null;
    projected.sortedNamedCategories = null;
    projected.allChannelsById = null;
    projected.firstVoiceChannel = undefined;
    // Keep Discord's quick-join candidate exactly as it was before this display change.
    if (typeof original.getFirstVoiceChannel === "function") projected.getFirstVoiceChannel = original.getFirstVoiceChannel.bind(original);
    projected.__hiddenChannelsProjection = true;
    // Verify the model before exposing it to native list code.
    const sections = projected.getSections();
    if (!Array.isArray(sections) || sections.some(n => !Number.isInteger(n) || n < 0)) return null;
    return projected;
}

function hiddenVoiceLayout(voice, fontScale = 1) {
    const scale = Math.max(1, Math.min(3, Number(fontScale) || 1));
    const count = voice?.people?.length || 0;
    const row = 30 * scale, header = 44 * scale, note = 26 * scale;
    return { scale, row, header, note, height: header + (voice ? Math.min(count, 10) * row + (!count || count > 10 ? note : 0) : 0) };
}


function createHiddenUI(api, runtime) {
    const React = api.metro.common.React, RN = api.metro.common.ReactNative, h = React.createElement;
    const c = { bg: "#17181f", card: "#242630", text: "#f2f3f5", muted: "#b4b7c5", accent: "#b3baff", line: "#3b3e4d" };
    const s = RN.StyleSheet.create({
        screen: { flex: 1, backgroundColor: c.bg }, body: { padding: 16, paddingBottom: 40 },
        title: { color: c.text, fontSize: 22, fontWeight: "700", marginBottom: 8 },
        text: { color: c.text, fontSize: 15, lineHeight: 22 }, muted: { color: c.muted, fontSize: 13, lineHeight: 19 },
        card: { backgroundColor: c.card, borderRadius: 12, padding: 14, marginTop: 10 },
        button: { borderColor: c.line, borderWidth: 1, borderRadius: 9, padding: 12, marginTop: 9 },
        buttonText: { color: c.accent, fontSize: 15, fontWeight: "600" },
        input: { color: c.text, backgroundColor: c.card, borderRadius: 9, borderWidth: 1, borderColor: c.line, padding: 12, marginTop: 12 },
        row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10 },
        inline: { padding: 14, marginTop: 8, borderTopWidth: 1, borderTopColor: c.line }
    });
    function text(value, style, props) { return h(RN.Text, Object.assign({ style: [s.text, style] }, props), value); }
    function button(label, onPress) { return h(RN.TouchableOpacity, { style: s.button, onPress, accessibilityRole: "button" }, text(label, s.buttonText)); }
    function useRefresh() {
        const [, setTick] = React.useState(0);
        React.useEffect(() => runtime.subscribe(() => setTick(v => v + 1)), []);
        return () => setTick(v => v + 1);
    }
    function channelRow(channel, onPress) {
        return h(RN.TouchableOpacity, { key: channel.id, style: s.card, onPress, accessibilityRole: "button", accessibilityLabel: "Hidden " + channel.typeName + " channel " + channel.name },
            text("🔒 " + channel.name, { fontWeight: "600" }),
            text(channel.typeName + " · " + channel.category, s.muted),
            channel.topic ? text(channel.topic, [s.muted, { marginTop: 5 }], { numberOfLines: 2 }) : null);
    }
    function VoiceDetails({ voice }) {
        if (!voice) return null;
        return h(RN.View, { style: s.card },
            text("Voice participants", { fontWeight: "700" }),
            text("Only participants and status received by this client are shown.", s.muted),
            voice.people.length ? voice.people.map(person => h(RN.View, { key: person.id, style: { marginTop: 10 } },
                text(person.name), person.flags.length ? text(person.flags.join(" · "), s.muted) : null))
                : text(voice.available ? "No participants are present in the received data. This does not confirm that the call is empty." : "Participant data is unavailable on this build.", [s.muted, { marginTop: 8 }]),
            voice.truncated ? text("Showing a limited participant list.", s.muted) : null);
    }
    function Details({ guildId, id, onBack }) {
        const d = runtime.detail(guildId, id);
        if (d.issue) return h(RN.View, null, button("Back to channels", onBack), text(d.issue, s.muted));
        return h(RN.View, null,
            button("Back to channels", onBack),
            text("🔒 " + d.name, [s.title, { marginTop: 18 }]),
            text(d.guildName + " · " + d.typeName, s.muted),
            h(RN.View, { style: s.card }, text("Channel details", { fontWeight: "700" }),
                text("Category: " + d.category),
                text("Topic: " + (d.topic || "Not present in cached metadata"), { marginTop: 8 }, { selectable: true }),
                text("Channel ID: " + d.id, [s.muted, { marginTop: 8 }], { selectable: true }),
                text("Server ID: " + d.guildId, s.muted, { selectable: true }),
                d.nsfw ? text("Marked age-restricted", s.muted) : null,
                d.slowmode ? text("Slowmode: " + d.slowmode + " seconds", s.muted) : null,
                d.bitrate ? text("Bitrate: " + Math.round(d.bitrate / 1000) + " kbps", s.muted) : null,
                d.userLimit ? text("Voice user limit: " + d.userLimit, s.muted) : null),
            h(VoiceDetails, { voice: d.voice }),
            h(RN.View, { style: s.card }, text("View permission rules", { fontWeight: "700" }),
                text("Cached channel rules, not a complete list of people who can access it.", s.muted),
                d.rules.length ? d.rules.map((rule, i) => text(rule.label + " · " + rule.value, { marginTop: 8 }, { key: rule.id + ":" + i }))
                    : text("No explicit view rules are available in the cached metadata.", [s.muted, { marginTop: 8 }])),
            text("Hidden messages and call audio cannot be accessed.", [s.muted, { marginTop: 14 }])
        );
    }
    function Viewer({ guildId, showSettings = false } = {}) {
        const refresh = useRefresh();
        const [chosenGuild, setGuild] = React.useState(guildId || "");
        const [choosing, setChoosing] = React.useState(false);
        const [query, setQuery] = React.useState("");
        const [selected, setSelected] = React.useState("");
        const [limit, setLimit] = React.useState(50);
        const data = runtime.snapshot(chosenGuild);
        const q = query.trim().toLowerCase();
        const filtered = data.hidden.filter(channel => [channel.name, channel.topic, channel.category, channel.id, channel.typeName].join("\n").toLowerCase().includes(q));
        function choose(id) { setGuild(id); setChoosing(false); setSelected(""); setQuery(""); setLimit(50); }
        return h(RN.ScrollView, { style: s.screen, contentContainerStyle: s.body, keyboardShouldPersistTaps: "handled" },
            text("Hidden channels", s.title),
            text("Names and details already received by your Discord client. Hidden messages cannot be read.", s.muted),
            showSettings ? h(RN.View, { style: s.card },
                text("Version " + (api.plugin.manifest?.version || "0.2.0") + " · Classic beta", s.muted),
                h(RN.View, { style: s.row }, h(RN.View, { style: { flex: 1, paddingRight: 10 } },
                    text("Show hidden channels in normal categories"), text("Real names with a lock; voice participants when available.", s.muted)),
                    h(RN.Switch, { value: runtime.inlineEnabled(), onValueChange: runtime.setInline, accessibilityLabel: "Show hidden channels in normal categories" })),
                text(runtime.status(), s.muted)) : null,
            button(data.guild ? data.guild.name + " · Change server" : "Choose a server", () => { setChoosing(!choosing); setSelected(""); }),
            choosing ? h(RN.View, null,
                data.guilds.length ? data.guilds.map(g => h(RN.TouchableOpacity, { key: g.id, style: s.button, onPress: () => choose(g.id), accessibilityRole: "button" }, text(g.name)))
                    : text(data.issue, s.muted)) : selected && data.guild ? h(Details, { guildId: data.guild.id, id: selected, onBack: () => setSelected("") }) : h(React.Fragment, null,
                h(RN.TextInput, { style: s.input, value: query, onChangeText: value => { setQuery(value); setLimit(50); }, placeholder: "Search names, topics, categories, or IDs", placeholderTextColor: c.muted, autoCapitalize: "none", accessibilityLabel: "Search hidden channel metadata" }),
                button("Refresh cached list", refresh),
                text(filtered.length + " hidden channel(s) · " + data.cached + " cached channel(s)", [s.muted, { marginTop: 14 }]),
                data.issue ? text(data.issue, [s.muted, { marginTop: 10 }]) : null,
                data.truncated ? text("The cache was too large to read completely; this list may be incomplete.", s.muted) : null,
                filtered.length ? filtered.slice(0, limit).map(channel => channelRow(channel, () => setSelected(channel.id)))
                    : text(query ? "No matching cached hidden channels." : "No hidden channels found in the available metadata. Discord may not send details for every channel.", [s.muted, { marginTop: 16 }]),
                filtered.length > limit ? button("Show more", () => setLimit(limit + 50)) : null)
        );
    }
    function LockedRow({ guildId, id }) {
        useRefresh();
        const enabled = runtime.inlineEnabled(), channel = runtime.row(guildId, id);
        React.useEffect(() => { if (enabled && channel) runtime.markInlineMounted(); }, [enabled, id]);
        if (!enabled || !channel) return null;
        const layout = hiddenVoiceLayout(channel.voice, RN.PixelRatio?.getFontScale?.() || 1);
        const people = channel.voice?.people || [];
        const label = "🔒 " + channel.name;
        return h(RN.TouchableOpacity, {
            style: { height: layout.height, paddingHorizontal: 16, overflow: "hidden" },
            accessibilityRole: "button", accessibilityLabel: label + ". Open channel details",
            onPress: () => runtime.showDetail(guildId, id)
        },
        h(RN.View, { style: { height: layout.header, justifyContent: "center" } },
            text(label, { color: c.muted, fontSize: 16 * layout.scale, lineHeight: 22 * layout.scale, fontWeight: "600" }, { numberOfLines: 1, allowFontScaling: false })),
        people.slice(0, 10).map(person => h(RN.View, { key: person.id, style: { height: layout.row, paddingLeft: 22, justifyContent: "center" } },
            text(person.name + (person.flags.length ? " · " + person.flags.join(" · ") : ""), { color: c.muted, fontSize: 12 * layout.scale, lineHeight: 18 * layout.scale }, { numberOfLines: 1, allowFontScaling: false }))),
        channel.voice && (!people.length || people.length > 10) ? h(RN.View, { style: { height: layout.note, paddingLeft: 22, justifyContent: "center" } },
            text(people.length > 10 ? "+ " + (people.length - 10) + " more · tap for details" : "Participant data unavailable or empty", { color: c.muted, fontSize: 11 * layout.scale, lineHeight: 16 * layout.scale }, { numberOfLines: 1, allowFontScaling: false })) : null);
    }
    function Modal({ guildId, onClose }) {
        const size = RN.Dimensions?.get?.("window") || { width: 360, height: 720 };
        const body = h(RN.View, { style: { height: Math.max(220, Math.min(600, size.height * 0.65)), width: "100%" } }, h(Viewer, { guildId }));
        const Alert = api.ui?.components?.Alert;
        return Alert ? h(Alert, { title: "Hidden Channels", confirmText: "Close", onConfirm: onClose, onCancel: onClose, isDismissable: true }, body)
            : h(RN.View, { style: { backgroundColor: c.bg, padding: 12, borderRadius: 12, width: Math.min(520, size.width - 32) } }, body, button("Close", onClose));
    }
    const Boundary = api.ui?.components?.ErrorBoundary;
    function guarded(Component, props) { const view = h(Component, props); return Boundary ? h(Boundary, null, view) : view; }
    return {
        Settings: () => guarded(Viewer, { showSettings: true }),
        Modal: props => guarded(Modal, props),
        LockedRow: props => guarded(LockedRow, props)
    };
}


function createHiddenPlugin(api) {
    const common = api.metro.common, React = common.React, RN = common.ReactNative;
    const model = hiddenChannelModel(), storage = api.plugin.storage || {};
    const disposers = [], subscribers = new Set();
    let active = false, loggedOut = false, channelStore, guildStore, permissionStore, userStore, selectedGuildStore, voiceStore, memberStore, listStore;
    let permissionCheck, viewPermission, ui, modalOpen = false, inlineMounted = false;
    let hookNames = [], lastIssue = "", reading = false;
    let showInline = storage.showInline !== false;
    let revision = 0, refreshTimer, inlineReady = false;
    const projections = new Map();
    function find(method, ...args) { try { return api.metro[method]?.(...args); } catch (_) {} }
    function store(name, ...props) { return find("findByStoreName", name) || find("findByProps", ...props); }
    function report(message) {
        lastIssue = message;
        try { api.logger?.warn?.("Hidden Channels: " + message); } catch (_) {}
    }
    function notify() {
        revision++; projections.clear();
        subscribers.forEach(fn => { try { fn(); } catch (_) {} });
    }
    function refreshList() {
        if (refreshTimer != null) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            try { listStore?.emitChange?.(); } catch (_) {}
        }, 32);
    }
    function guilds() {
        try {
            if (!active || loggedOut || !userStore?.getCurrentUser?.()?.id) return [];
            const value = guildStore?.getGuilds?.() || {};
            const list = Object.prototype.toString.call(value) === "[object Map]" ? Array.from(value.values()) : Object.values(value);
            return list.filter(g => g?.id).map(g => ({ id: String(g.id), name: typeof g.name === "string" ? g.name : String(g.id) }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch (_) { report("Server metadata is unavailable on this build."); return []; }
    }
    function currentGuild() { try { return String(selectedGuildStore?.getGuildId?.() || ""); } catch (_) { return ""; } }
    function getChannel(id) { try { return channelStore?.getChannel?.(id); } catch (_) {} }
    function isHidden(channel) {
        try {
            if (!active || loggedOut || !channel || !userStore?.getCurrentUser?.()?.id) return false;
            const id = String(channel.guild_id || channel.guildId || ""), joined = guildStore?.getGuilds?.();
            const present = Object.prototype.toString.call(joined) === "[object Map]" ? joined.has(id) : joined && Object.prototype.hasOwnProperty.call(joined, id);
            return !!present && viewPermission !== undefined && permissionCheck?.call(permissionStore, viewPermission, channel) === false;
        } catch (_) { return false; }
    }
    function voice(guildId, id) {
        const channel = getChannel(id);
        if (!isHidden(channel) || String(channel.guild_id || channel.guildId) !== String(guildId) || ![2, 13].includes(Number(channel.type))) return null;
        let states;
        try { states = voiceStore?.getVoiceStatesForChannel?.(id); } catch (_) {}
        return model.voiceParticipants(states, id, guildId, id => userStore?.getUser?.(id), (guild, id) => memberStore?.getMember?.(guild, id));
    }
    function rawChannels(guildId) {
        const sources = [], failures = [];
        const read = (method, ...args) => {
            if (typeof channelStore?.[method] !== "function") return;
            try { sources.push(channelStore[method](...args)); } catch (_) { failures.push(method); }
        };
        read("getMutableGuildChannelsForGuild", guildId);
        if (!model.channelsFrom(sources, guildId).records.length) read("getChannels");
        if (!model.channelsFrom(sources, guildId).records.length) read("getChannels", guildId);
        if (!model.channelsFrom(sources, guildId).records.length) read("getAllChannels");
        if (!sources.length) return { sources, error: failures.length ? "The channel metadata getter failed on this build." : "No supported cached-channel getter was found." };
        return { sources, error: "" };
    }
    function snapshot(requestedGuild) {
        const available = guilds();
        const chosen = requestedGuild || currentGuild() || available[0]?.id || "";
        const guild = available.find(g => g.id === String(chosen));
        const result = { guilds: available, guild, hidden: [], cached: 0, unknown: 0, truncated: false, issue: "" };
        if (!active) { result.issue = "Enable this plugin to browse cached channels."; return result; }
        if (!available.length) { result.issue = "No cached servers are available. Sign in and open a server first."; return result; }
        if (!guild) { result.issue = "This server is no longer available for this account. Choose another server."; return result; }
        if (typeof permissionCheck !== "function" || viewPermission === undefined) { result.issue = "The channel permission reader is unavailable on this Classic build."; return result; }
        if (reading) { result.issue = "The channel cache is busy. Tap Refresh."; return result; }
        reading = true;
        try {
            const raw = rawChannels(guild.id);
            if (raw.error) { result.issue = raw.error; return result; }
            Object.assign(result, model.catalog(raw.sources, guild.id, channel => permissionCheck.call(permissionStore, viewPermission, channel)));
            if (!result.cached) result.issue = "No channel metadata is cached for this server yet. Open its channel list, then refresh.";
            else if (result.unknown) result.issue = result.unknown + " cached channel(s) could not be classified by the permission reader.";
            return result;
        } catch (_) { result.issue = "Could not read this server's cached channel metadata."; return result; }
        finally { reading = false; }
    }
    function detail(guildId, id) {
        const data = snapshot(guildId), channel = data.hidden.find(c => c.id === id);
        if (!channel) return { issue: "This channel is no longer in the cached hidden-channel list." };
        let roles = {};
        try { roles = guildStore?.getGuild?.(guildId)?.roles || {}; } catch (_) {}
        return { ...channel, guildName: data.guild.name, rules: model.rules(getChannel(id), roles, guildId), voice: voice(guildId, id) };
    }
    function showDetail(guildId, id) {
        const d = detail(guildId, id);
        RN.Alert.alert(d.issue ? "Hidden Channels" : "🔒 " + d.name, d.issue || [
            d.typeName + " · " + d.category,
            d.topic || "No topic is available in the cached metadata.",
            d.voice ? (d.voice.people.length ? "Voice participants received by this client:\n" + d.voice.people.map(p => p.name + (p.flags.length ? " · " + p.flags.join(", ") : "")).join("\n") : "Participant data is unavailable or empty; this does not confirm the call is empty.") : "",
            "Channel ID: " + d.id,
            "Hidden messages and call audio cannot be accessed."
        ].filter(Boolean).join("\n\n"));
    }
    function fallback(guildId) {
        const data = snapshot(guildId);
        const names = data.hidden.slice(0, 12).map(c => "🔒 " + c.name + " · " + c.typeName).join("\n");
        RN.Alert.alert("Hidden Channels", (data.issue || names || "No hidden channels were found in the cached metadata.")
            + "\n\nFull viewer: Revenge → Plugins → Hidden Channels → Settings.");
    }
    function closeModal() {
        if (!modalOpen) return;
        modalOpen = false;
        try { find("findByProps", "openLazy", "close")?.close?.(); } catch (_) {}
    }
    function openViewer(guildId) {
        if (!active) return;
        try {
            const alerts = find("findByProps", "openLazy", "close");
            if (!api.ui?.alerts?.showCustomAlert || !alerts?.close) { fallback(guildId); return; }
            modalOpen = true;
            const pending = api.ui.alerts.showCustomAlert(ui.Modal, { guildId, onClose: closeModal });
            if (pending?.catch) pending.catch(() => { modalOpen = false; if (active) fallback(guildId); });
        } catch (_) { modalOpen = false; fallback(guildId); }
    }
    function installInline() {
        const renderer = find("findByProps", "renderChannelListItem", "getChannelListItemSize", "getFastListRecyclerKey");
        if (!listStore?.getGuild || !renderer || !api.patcher?.instead) return;
        const patches = [];
        function hiddenRow(props) {
            if (!active || loggedOut || !showInline) return;
            try {
                const row = props?.guildChannels?.getChannelFromSectionRow?.(props.section, props.row)?.channel;
                const channel = row?.record;
                if (isHidden(channel)) return channel;
            } catch (_) {}
        }
        try {
            // Install the safe renderer first, then expose the extra display rows.
            patches.push(api.patcher.instead("renderChannelListItem", renderer, (args, original) => {
                const channel = hiddenRow(args[0]);
                if (!channel) return original(...args);
                return React.createElement(ui.LockedRow, { guildId: String(channel.guild_id || channel.guildId), id: String(channel.id) });
            }));
            patches.push(api.patcher.instead("getChannelListItemSize", renderer, (args, original) => {
                const channel = hiddenRow(args[0]);
                if (!channel) return original(...args);
                return hiddenVoiceLayout(voice(String(channel.guild_id || channel.guildId), String(channel.id)), args[0]?.fontScale).height;
            }));
            // Native categories retain their collapse behavior; only the displayed name gains a lock.
            if (typeof renderer.renderChannelListSectionHeader === "function") {
                patches.push(api.patcher.after("renderChannelListSectionHeader", renderer, (args, tree) => {
                    if (!active || !showInline || !React.isValidElement(tree)) return tree;
                    const channel = tree.props?.channel;
                    if (!isHidden(channel) || Number(channel.type) !== 4) return tree;
                    const display = Object.assign(Object.create(Object.getPrototypeOf(channel)), channel, { name: "🔒 " + (channel.name || "Name unavailable") });
                    return React.cloneElement(tree, { channel: display });
                }));
            }
            const project = (args, result) => {
                if (!active || loggedOut || !showInline || !result?.guildChannels) return result;
                const guildId = String(args[0] || ""), original = result.guildChannels;
                if (original.__hiddenChannelsProjection || String(original.id) !== guildId) return result;
                const cached = projections.get(guildId);
                if (cached?.original === original && cached.version === result.guildChannelsVersion) return cached.result;
                try {
                    const data = snapshot(guildId);
                    if (!data.hidden.length) return result;
                    const projected = projectHiddenChannels(original, data.hidden, getChannel);
                    if (!projected) { report("The channel-list model changed on this build. Use the settings viewer."); return result; }
                    const next = { ...result, guildChannels: projected, guildChannelsVersion: (Number(result.guildChannelsVersion) || 0) + revision };
                    projections.set(guildId, { original, version: result.guildChannelsVersion, result: next });
                    return next;
                } catch (_) { report("The channel-list layout is unsupported. Use the settings viewer."); return result; }
            };
            for (const key of ["getGuild", "getGuildWithoutChangingGuildActionRows"]) {
                if (typeof listStore[key] === "function") patches.push(api.patcher.after(key, listStore, project));
            }
            disposers.push(...patches); inlineReady = true; hookNames.push("349.9 channel-list renderer");
        } catch (_) {
            for (const undo of patches.reverse()) { try { undo(); } catch (_) {} }
            report("Could not attach the native channel-list adapter.");
        }
    }
    const runtime = {
        snapshot, detail, showDetail, openViewer, closeModal, voice,
        row(guildId, id) {
            const channel = getChannel(id);
            if (!isHidden(channel) || String(channel.guild_id || channel.guildId) !== String(guildId)) return null;
            return { id, guildId, name: typeof channel.name === "string" && channel.name ? channel.name : "Name unavailable", type: Number(channel.type), voice: voice(guildId, id) };
        },
        subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
        inlineEnabled: () => active && showInline,
        setInline(value) { showInline = !!value; storage.showInline = showInline; notify(); refreshList(); },
        markInlineMounted() { inlineMounted = true; },
        status() {
            return "Channels in normal categories: " + (!showInline ? "off" : inlineMounted ? "displayed" : inlineReady ? "adapter ready; reopen a server" : "unavailable on this build; use the viewer below")
                + "." + (lastIssue ? " " + lastIssue : "");
        }
    };
    ui = createHiddenUI(api, runtime);
    function onLoad() {
        if (active) return;
        channelStore = store("ChannelStore", "getChannel", "getChannels");
        guildStore = store("GuildStore", "getGuild", "getGuilds");
        userStore = store("UserStore", "getCurrentUser");
        selectedGuildStore = store("SelectedGuildStore", "getGuildId");
        permissionStore = store("PermissionStore", "getChannelPermissions", "can");
        voiceStore = find("findByStoreName", "VoiceStateStore") || find("findByProps", "getVoiceStatesForChannel", "getVoiceStateForUser");
        memberStore = store("GuildMemberStore", "getMember", "getMembers");
        listStore = find("findByStoreName", "ChannelListStore") || find("findByProps", "getGuild", "getGuildWithoutChangingGuildActionRows");
        permissionCheck = permissionStore?.can;
        viewPermission = common.constants?.Permissions?.VIEW_CHANNEL ?? find("findByProps", "Permissions")?.Permissions?.VIEW_CHANNEL;
        active = true; loggedOut = false; inlineMounted = false; inlineReady = false; hookNames = []; lastIssue = "";
        for (const source of new Set([channelStore, guildStore, permissionStore, userStore, selectedGuildStore, voiceStore, memberStore])) {
            if (!source?.addChangeListener || !source?.removeChangeListener) continue;
            const change = () => { notify(); refreshList(); };
            try { source.addChangeListener(change); disposers.push(() => source.removeChangeListener(change)); } catch (_) {}
        }
        const dispatcher = common.FluxDispatcher;
        if (dispatcher?.subscribe && dispatcher?.unsubscribe) {
            const logout = () => { loggedOut = true; closeModal(); notify(); refreshList(); };
            const login = () => { loggedOut = false; notify(); refreshList(); };
            for (const [event, callback] of [["LOGOUT", logout], ["CONNECTION_OPEN", login]]) {
                dispatcher.subscribe(event, callback); disposers.push(() => dispatcher.unsubscribe(event, callback));
            }
        }
        installInline();
        refreshList();
        if (api.commands?.registerCommand) {
            try {
                disposers.push(api.commands.registerCommand({ name: "hidden", description: "Browse cached hidden-channel names and details", options: [],
                    execute(_args, context) {
                        const channel = context?.channel;
                        openViewer(channel?.guild_id || (channel?.id && getChannel(channel.id)?.guild_id) || currentGuild());
                        // Do not return an object: Classic sends returned objects as messages.
                    }
                }));
            } catch (_) { report("The /hidden shortcut is unavailable. Use the settings viewer."); }
        }
    }
    function onUnload() {
        active = false; closeModal(); notify();
        if (refreshTimer != null) { clearTimeout(refreshTimer); refreshTimer = undefined; }
        for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch (_) {} }
        hookNames = []; inlineMounted = false; inlineReady = false;
        try { listStore?.emitChange?.(); } catch (_) {}
    }
    return { onLoad, onUnload, settings: ui.Settings };
}


return createHiddenPlugin(vendetta);
})()
