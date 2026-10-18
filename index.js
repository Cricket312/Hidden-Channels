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
                typeName: types[channel.type], name: text(channel.name) || "Unnamed channel",
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
    return { channelsFrom, catalog, rules };
}


/* Add our own metadata rows only to a recognized server list's footer. */
function attachHiddenFooter(React, tree, Section, guildId) {
    let count = 0;
    function visit(node, depth) {
        if (!node || depth > 12) return node;
        if (Array.isArray(node)) {
            const result = node.map(child => visit(child, depth + 1));
            return result.some((child, i) => child !== node[i]) ? result : node;
        }
        if (!React.isValidElement(node)) return node;
        const props = node.props || {};
        if (typeof props.renderItem === "function" && (Array.isArray(props.data) || Array.isArray(props.sections))) {
            const Previous = props.ListFooterComponent;
            if (Previous?.__hiddenChannelsFooter) return node;
            function HiddenChannelsFooter(footerProps) {
                const previous = React.isValidElement(Previous) ? Previous : Previous ? React.createElement(Previous, footerProps) : null;
                return React.createElement(React.Fragment, null, previous, React.createElement(Section, { guildId }));
            }
            HiddenChannelsFooter.__hiddenChannelsFooter = true;
            count++;
            return React.cloneElement(node, { ListFooterComponent: HiddenChannelsFooter });
        }
        if (props.children) {
            const children = visit(props.children, depth + 1);
            if (children !== props.children) return React.cloneElement(node, { children });
        }
        return node;
    }
    return { tree: visit(tree, 0), count };
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
            h(RN.View, { style: s.card }, text("View permission rules", { fontWeight: "700" }),
                text("Cached channel rules, not a complete list of people who can access it.", s.muted),
                d.rules.length ? d.rules.map((rule, i) => text(rule.label + " · " + rule.value, { marginTop: 8 }, { key: rule.id + ":" + i }))
                    : text("No explicit view rules are available in the cached metadata.", [s.muted, { marginTop: 8 }])),
            text("Messages and voice are not accessible through this viewer.", [s.muted, { marginTop: 14 }])
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
                text("Version " + (api.plugin.manifest?.version || "0.1.0") + " · Classic beta", s.muted),
                h(RN.View, { style: s.row }, h(RN.View, { style: { flex: 1, paddingRight: 10 } },
                    text("Show locked section in server list"), text("Requires a compatible mobile list layout.", s.muted)),
                    h(RN.Switch, { value: runtime.inlineEnabled(), onValueChange: runtime.setInline, accessibilityLabel: "Show locked section in server list" })),
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
    function InlineSection({ guildId }) {
        useRefresh();
        const data = runtime.snapshot(guildId), enabled = runtime.inlineEnabled();
        React.useEffect(() => { if (enabled && data.hidden.length) runtime.markInlineMounted(); }, [enabled, data.hidden.length]);
        if (!enabled || !data.guild || !data.hidden.length) return null;
        return h(RN.View, { style: s.inline },
            text("🔒 Hidden channels · " + data.hidden.length, { fontWeight: "700" }),
            text("Channel details only", s.muted),
            data.hidden.slice(0, 20).map(channel => channelRow(channel, () => runtime.showDetail(guildId, channel.id))),
            button("Browse and search hidden channels", () => runtime.openViewer(guildId)));
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
        InlineSection: props => guarded(InlineSection, props)
    };
}


function createHiddenPlugin(api) {
    const common = api.metro.common, React = common.React, RN = common.ReactNative;
    const model = hiddenChannelModel(), storage = api.plugin.storage || {};
    const disposers = [], subscribers = new Set();
    let active = false, loggedOut = false, channelStore, guildStore, permissionStore, userStore, selectedGuildStore;
    let permissionCheck, viewPermission, ui, modalOpen = false, inlineMounted = false;
    let hookNames = [], lastIssue = "", reading = false;
    let showInline = storage.showInline !== false;
    function find(method, ...args) { try { return api.metro[method]?.(...args); } catch (_) {} }
    function store(name, ...props) { return find("findByStoreName", name) || find("findByProps", ...props); }
    function report(message) {
        lastIssue = message;
        try { api.logger?.warn?.("Hidden Channels: " + message); } catch (_) {}
    }
    function notify() { subscribers.forEach(fn => { try { fn(); } catch (_) {} }); }
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
    function rawChannels(guildId) {
        const sources = [], failures = [];
        const read = (method, ...args) => {
            if (typeof channelStore?.[method] !== "function") return;
            try { sources.push(channelStore[method](...args)); } catch (_) { failures.push(method); }
        };
        read("getMutableGuildChannelsForGuild", guildId);
        read("getChannels");
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
        return { ...channel, guildName: data.guild.name, rules: model.rules(getChannel(id), roles, guildId) };
    }
    function showDetail(guildId, id) {
        const d = detail(guildId, id);
        RN.Alert.alert(d.issue ? "Hidden Channels" : "🔒 " + d.name, d.issue || [
            d.typeName + " · " + d.category,
            d.topic || "No topic is available in the cached metadata.",
            "Channel ID: " + d.id,
            "Messages and voice are not accessible through this viewer."
        ].join("\n\n"));
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
        const seen = new Set();
        for (const name of ["GuildChannels", "GuildChannelList", "GuildChannelsList", "ChannelList", "ChannelListConnected"]) {
            const module = find("findByName", name, false) || find("findByDisplayName", name, false);
            if (!module || seen.has(module)) continue;
            const key = typeof module.default === "function" ? "default" : typeof module[name] === "function" ? name : null;
            if (!key) continue;
            seen.add(module);
            try {
                disposers.push(api.patcher.after(key, module, (args, tree) => {
                    if (!active || loggedOut || !showInline) return tree;
                    const props = args[0] || {};
                    const guildId = String(props.guildId || props.guild_id || props.guild?.id || currentGuild() || "");
                    if (!guildId || !guilds().some(g => g.id === guildId)) return tree;
                    try { return attachHiddenFooter(React, tree, ui.InlineSection, guildId).tree; }
                    catch (_) { report("The server-list section is unavailable; use the settings viewer."); return tree; }
                }));
                hookNames.push(name);
            } catch (_) {}
        }
    }
    const runtime = {
        snapshot, detail, showDetail, openViewer, closeModal,
        subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
        inlineEnabled: () => active && showInline,
        setInline(value) { showInline = !!value; storage.showInline = showInline; notify(); },
        markInlineMounted() { if (!inlineMounted) { inlineMounted = true; notify(); } },
        status() {
            return "Server-list section: " + (!showInline ? "off" : inlineMounted ? "displayed" : hookNames.length ? "hook found; waiting for a supported list layout" : "unavailable on this build; use the viewer below")
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
        permissionCheck = permissionStore?.can;
        viewPermission = common.constants?.Permissions?.VIEW_CHANNEL ?? find("findByProps", "Permissions")?.Permissions?.VIEW_CHANNEL;
        active = true; loggedOut = false; inlineMounted = false; hookNames = []; lastIssue = "";
        for (const source of new Set([channelStore, guildStore, permissionStore, userStore, selectedGuildStore])) {
            if (!source?.addChangeListener || !source?.removeChangeListener) continue;
            try { source.addChangeListener(notify); disposers.push(() => source.removeChangeListener(notify)); } catch (_) {}
        }
        const dispatcher = common.FluxDispatcher;
        if (dispatcher?.subscribe && dispatcher?.unsubscribe) {
            const logout = () => { loggedOut = true; closeModal(); notify(); };
            const login = () => { loggedOut = false; notify(); };
            for (const [event, callback] of [["LOGOUT", logout], ["CONNECTION_OPEN", login]]) {
                dispatcher.subscribe(event, callback); disposers.push(() => dispatcher.unsubscribe(event, callback));
            }
        }
        installInline();
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
        for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch (_) {} }
        hookNames = []; inlineMounted = false;
    }
    return { onLoad, onUnload, settings: ui.Settings };
}


return createHiddenPlugin(vendetta);
})()
