-- Glyph VR control script for mpv.
-- Exposes script-messages to enable/disable v360 projection and control yaw/pitch/fov.

local mp = require 'mp'

local state = {
    enabled = false,
    projection = "360", -- 360 | 180
    stereo = "mono",    -- mono | sbs | ou
    yaw = 0.0,
    pitch = 0.0,
    fov = 105.0,
    dragging = false,
    last_x = nil,
    last_y = nil,
    drag_timer = nil,
    last_apply_ts = 0.0,
    out_w = 1280,
    out_h = 720,
}

local function clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

local function norm_projection(v)
    local s = tostring(v or ""):lower()
    if s == "180" then return "180" end
    return "360"
end

local function norm_stereo(v)
    local s = tostring(v or ""):lower()
    if s == "sbs" then return "sbs" end
    if s == "ou" then return "ou" end
    return "mono"
end

local function build_filter()
    local input = "equirect"
    local in_stereo = "2d"
    if state.stereo == "sbs" then in_stereo = "sbs" end
    if state.stereo == "ou" then in_stereo = "tb" end

    local parts = {
        "input=" .. input,
        "output=flat",
        "in_stereo=" .. in_stereo,
        "out_stereo=2d",
        "w=" .. tostring(state.out_w),
        "h=" .. tostring(state.out_h),
        "interp=linear",
        string.format("yaw=%.3f", state.yaw),
        string.format("pitch=%.3f", state.pitch),
        string.format("h_fov=%.3f", state.fov),
        string.format("v_fov=%.3f", state.fov),
    }

    return table.concat(parts, ":")
end

local function apply_vr(show_osd)
    if not state.enabled then
        mp.commandv("vf", "remove", "@glyphvr")
        return
    end
    local vf = build_filter()
    local ok = pcall(mp.commandv, "vf", "set", "@glyphvr:v360=" .. vf)
    if not ok then
        state.enabled = false
        mp.commandv("vf", "remove", "@glyphvr")
        mp.osd_message("VR Filter Fehler - deaktiviert", 1.4)
        return
    end
    if show_osd == nil or show_osd == true then
        local msg = string.format("VR: %s %s | yaw %.0f pitch %.0f fov %.0f",
            state.projection, string.upper(state.stereo), state.yaw, state.pitch, state.fov)
        mp.osd_message(msg, 0.9)
    end
end

local function vr_set_enabled(v)
    local s = tostring(v or ""):lower()
    state.enabled = (s == "1" or s == "true" or s == "yes" or s == "on")
    apply_vr(true)
    if state.enabled then
        mp.osd_message("VR aktiv (Alt+Pfeile, Alt+PgUp/PgDn, Alt+R)", 2.2)
    end
end

local function vr_set_mode(projection, stereo)
    state.projection = norm_projection(projection)
    state.stereo = norm_stereo(stereo)
    apply_vr(true)
end

local function vr_look(dyaw, dpitch)
    state.yaw = clamp(state.yaw + (tonumber(dyaw) or 0.0), -180.0, 180.0)
    state.pitch = clamp(state.pitch + (tonumber(dpitch) or 0.0), -89.0, 89.0)
    local now = mp.get_time()
    if (now - state.last_apply_ts) >= 0.04 then
        state.last_apply_ts = now
        apply_vr(false)
    end
end

local function vr_set_fov(v)
    state.fov = clamp(tonumber(v) or state.fov, 45.0, 140.0)
    apply_vr(false)
end

local function vr_reset_view()
    state.yaw = 0.0
    state.pitch = 0.0
    apply_vr(true)
end

local function get_mouse_pos()
    local p = mp.get_property_native("mouse-pos")
    if type(p) ~= "table" then return nil, nil end
    return tonumber(p.x), tonumber(p.y)
end

local function vr_begin_drag()
    if not state.enabled then return end
    state.dragging = true
    state.last_x, state.last_y = get_mouse_pos()
    if state.drag_timer == nil then
        state.drag_timer = mp.add_periodic_timer(1 / 30, function()
            vr_on_mouse_move()
        end)
    else
        state.drag_timer:resume()
    end
end

local function vr_end_drag()
    state.dragging = false
    state.last_x = nil
    state.last_y = nil
    if state.drag_timer then
        state.drag_timer:stop()
    end
end

local function on_drag_binding(ev)
    local evname = tostring((ev and ev.event) or "")
    if evname == "down" or evname == "press" then
        vr_begin_drag()
    elseif evname == "up" or evname == "release" then
        vr_end_drag()
    end
end

local function vr_on_mouse_move()
    if not state.enabled or not state.dragging then return end
    local x, y = get_mouse_pos()
    if not x or not y then return end
    if state.last_x == nil or state.last_y == nil then
        state.last_x, state.last_y = x, y
        return
    end
    local dx = x - state.last_x
    local dy = y - state.last_y
    state.last_x, state.last_y = x, y
    if math.abs(dx) < 0.01 and math.abs(dy) < 0.01 then return end
    -- Mouse drag sensitivity tuned for desktop use.
    vr_look(dx * 0.28, -dy * 0.28)
end

local function vr_get_state()
    local payload = string.format(
        "{\"enabled\":%s,\"projection\":\"%s\",\"stereo\":\"%s\",\"yaw\":%.3f,\"pitch\":%.3f,\"fov\":%.3f}",
        state.enabled and "true" or "false",
        state.projection,
        state.stereo,
        state.yaw,
        state.pitch,
        state.fov
    )
    mp.commandv("script-message", "glyph-vr-state", payload)
end

mp.register_script_message("vr-set-enabled", vr_set_enabled)
mp.register_script_message("vr-set-mode", vr_set_mode)
mp.register_script_message("vr-look", vr_look)
mp.register_script_message("vr-set-fov", vr_set_fov)
mp.register_script_message("vr-reset-view", vr_reset_view)
mp.register_script_message("vr-get-state", vr_get_state)

mp.register_event("file-loaded", function()
    if state.enabled then apply_vr(true) end
end)

-- Direct keybindings inside mpv window (works even if Electron window is hidden).
mp.add_forced_key_binding("Alt+LEFT", "glyph_vr_left", function()
    if not state.enabled then return end
    vr_look(-5, 0)
end)
mp.add_forced_key_binding("Alt+RIGHT", "glyph_vr_right", function()
    if not state.enabled then return end
    vr_look(5, 0)
end)
mp.add_forced_key_binding("Alt+UP", "glyph_vr_up", function()
    if not state.enabled then return end
    vr_look(0, 3)
end)
mp.add_forced_key_binding("Alt+DOWN", "glyph_vr_down", function()
    if not state.enabled then return end
    vr_look(0, -3)
end)
mp.add_forced_key_binding("Alt+PGUP", "glyph_vr_fov_in", function()
    if not state.enabled then return end
    vr_set_fov(state.fov - 5)
end)
mp.add_forced_key_binding("Alt+PGDWN", "glyph_vr_fov_out", function()
    if not state.enabled then return end
    vr_set_fov(state.fov + 5)
end)
mp.add_forced_key_binding("Alt+r", "glyph_vr_reset", function()
    if not state.enabled then return end
    vr_reset_view()
end)

-- Mouse controls for VR:
-- Hold right mouse button and drag to look around.
-- Mouse wheel changes FOV.
mp.add_forced_key_binding("MBTN_RIGHT", "glyph_vr_drag", function(ev)
    on_drag_binding(ev)
end, { complex = true })

-- Fallback key names depending on mpv input backend/platform.
mp.add_forced_key_binding("MOUSE_BTN2", "glyph_vr_drag_btn2", function(ev)
    on_drag_binding(ev)
end, { complex = true })

mp.add_forced_key_binding("MBTN_RIGHT_DBL", "glyph_vr_drag_dbl", function()
    -- swallow double-click so it won't trigger other actions while in VR sessions
end)

mp.add_forced_key_binding("WHEEL_UP", "glyph_vr_wheel_in", function()
    if not state.enabled then return end
    vr_set_fov(state.fov - 2)
end)

mp.add_forced_key_binding("WHEEL_DOWN", "glyph_vr_wheel_out", function()
    if not state.enabled then return end
    vr_set_fov(state.fov + 2)
end)

mp.add_forced_key_binding("MOUSE_BTN3", "glyph_vr_wheel_in_alt", function()
    if not state.enabled then return end
    vr_set_fov(state.fov - 2)
end)

mp.add_forced_key_binding("MOUSE_BTN4", "glyph_vr_wheel_out_alt", function()
    if not state.enabled then return end
    vr_set_fov(state.fov + 2)
end)
