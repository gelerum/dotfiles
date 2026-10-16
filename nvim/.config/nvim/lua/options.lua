-- =============================================
-- BASIC NEOVIM OPTIONS
-- =============================================

-- Leader key (must be first!)
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- System clipboard
vim.opt.clipboard = "unnamedplus"

-- OSC 52: буфер обмена через сам терминал, без wl-copy/xclip.
-- Нужно там, где системного буфера нет: по SSH и в контейнере devenv.
-- Локально остаётся обычный провайдер.
-- Для вставки ghostty должен отдавать буфер без вопроса: clipboard-read = allow.
-- provider#clipboard#Executable() тут не годится: он загружает провайдер
-- раньше, чем задан g:clipboard, и тот потом пишет "No provider".
local native = (vim.env.WAYLAND_DISPLAY and vim.fn.executable("wl-copy") == 1)
	or (vim.env.DISPLAY and (vim.fn.executable("xclip") == 1 or vim.fn.executable("xsel") == 1))
if vim.env.SSH_TTY or not native then
	local osc52 = require("vim.ui.clipboard.osc52")
	vim.g.clipboard = {
		name = "OSC 52",
		copy = { ["+"] = osc52.copy("+"), ["*"] = osc52.copy("*") },
		paste = { ["+"] = osc52.paste("+"), ["*"] = osc52.paste("*") },
	}
end

-- Mouse
vim.opt.mouse = "a"

-- Line numbers
vim.opt.number = true
vim.opt.relativenumber = true

-- Indentation
vim.opt.tabstop = 4
vim.opt.shiftwidth = 4
vim.opt.expandtab = true
vim.opt.smartindent = true

-- Search
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.hlsearch = true
vim.opt.incsearch = true

-- Visuals / UI
vim.opt.termguicolors = true
vim.opt.signcolumn = "yes"
vim.opt.scrolloff = 999 -- курсор всегда по центру экрана
vim.opt.sidescrolloff = 8
vim.opt.cursorline = true
vim.opt.winborder = "rounded" -- рамки у hover / diagnostics float

-- Word wrap
vim.opt.wrap = true
vim.opt.linebreak = true -- перенос по словам, а не посреди слова
vim.opt.breakindent = true -- перенесённые строки сохраняют отступ
vim.opt.showbreak = "↪ " -- маркер в начале перенесённой строки

-- Behavior
vim.opt.undofile = true
vim.opt.updatetime = 250
vim.opt.timeoutlen = 300
vim.opt.splitright = true
vim.opt.splitbelow = true
vim.opt.confirm = true -- вместо ошибки "no write since last change" спросить
vim.opt.completeopt = { "menu", "menuone", "noselect" }

-- Disable built-in providers (faster startup)
vim.g.loaded_python3_provider = 0
vim.g.loaded_ruby_provider = 0
vim.g.loaded_perl_provider = 0
vim.g.loaded_node_provider = 0

-- Disable netrw (используем nvim-tree)
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

-- Disable startup message on empty buffer
vim.opt.shortmess:append("I")

-- Подсветить скопированный текст
vim.api.nvim_create_autocmd("TextYankPost", {
	desc = "Highlight on yank",
	callback = function()
		vim.hl.on_yank()
	end,
})
