-- =============================================
-- BASIC NEOVIM OPTIONS
-- =============================================

-- Leader key (must be first!)
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- System clipboard
vim.opt.clipboard = "unnamedplus"

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
