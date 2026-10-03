-- =============================================
-- TELESCOPE KEYMAPS
-- =============================================
-- Важно: telescope НЕ требуется на верхнем уровне — иначе lazy.nvim
-- подгрузит его прямо на старте и ленивая загрузка теряет смысл.

local map = vim.keymap.set

---Обёртка: вызывает builtin-пикер только в момент нажатия клавиши.
---@param picker string
---@param opts table|nil
local function tb(picker, opts)
	return function()
		require("telescope.builtin")[picker](opts or {})
	end
end

-- Telescope Prefix: <leader>f (find)

-- Most Used
map("n", "<leader>ff", tb("find_files"), { desc = "Find Files" })
map("n", "<leader>fg", tb("live_grep"), { desc = "Live Grep (Search Text)" })
map("n", "<leader>fb", tb("buffers"), { desc = "Find Buffers" })
map("n", "<leader>fh", tb("help_tags"), { desc = "Help Tags" })
map("n", "<leader>fo", tb("oldfiles"), { desc = "Recent Files" })
map("n", "<leader>fw", tb("grep_string"), { desc = "Grep Word Under Cursor" })
map("n", "<leader>/", tb("current_buffer_fuzzy_find"), { desc = "Search In Current Buffer" })

-- Совсем всё: скрытые + игнорируемые git'ом (.env, node_modules, .venv, build...)
-- <leader>ff уже показывает скрытые файлы; <leader>fa добавляет и gitignore-нутые.
map(
	"n",
	"<leader>fa",
	tb("find_files", { hidden = true, no_ignore = true }),
	{ desc = "Find Files (All, incl. ignored)" }
)
map(
	"n",
	"<leader>fG",
	tb("live_grep", { additional_args = { "--no-ignore" } }),
	{ desc = "Live Grep (All, incl. ignored)" }
)

-- Search in current file's directory
map("n", "<leader>fF", function()
	require("telescope.builtin").find_files({ cwd = vim.fn.expand("%:p:h") })
end, { desc = "Find Files (Current Directory)" })

-- Git related (very useful)
map("n", "<leader>gc", tb("git_commits"), { desc = "Git Commits" })
map("n", "<leader>gs", tb("git_status"), { desc = "Git Status" })
map("n", "<leader>gb", tb("git_branches"), { desc = "Git Branches" })

-- Other useful searches
map("n", "<leader>fc", tb("commands"), { desc = "Commands" })
map("n", "<leader>fk", tb("keymaps"), { desc = "Keymaps" })
map("n", "<leader>fM", tb("marks"), { desc = "Marks" })
map("n", "<leader>fr", tb("registers"), { desc = "Registers" })

-- Diagnostics
map("n", "<leader>fd", tb("diagnostics"), { desc = "Diagnostics (Telescope)" })

-- Resume last Telescope search
map("n", "<leader>fR", tb("resume"), { desc = "Resume Last Search" })

-- =============================================
-- DIAGNOSTICS  (префикс <leader>l — lsp; <leader>d отдан под cut)
-- =============================================
map("n", "<leader>ll", vim.diagnostic.open_float, { desc = "Line Diagnostics" })
map("n", "<leader>lq", vim.diagnostic.setloclist, { desc = "Diagnostics To Loclist" })

-- =============================================
-- General Keymaps
-- =============================================

-- Better window navigation
map("n", "<C-h>", "<C-w>h", { desc = "Go Left" })
map("n", "<C-j>", "<C-w>j", { desc = "Go Down" })
map("n", "<C-k>", "<C-w>k", { desc = "Go Up" })
map("n", "<C-l>", "<C-w>l", { desc = "Go Right" })

-- Resize windows (Ctrl + Arrows as backup)
map("n", "<C-Up>", "<cmd>resize +2<CR>", { desc = "Increase Height" })
map("n", "<C-Down>", "<cmd>resize -2<CR>", { desc = "Decrease Height" })
map("n", "<C-Left>", "<cmd>vertical resize -2<CR>", { desc = "Decrease Width" })
map("n", "<C-Right>", "<cmd>vertical resize +2<CR>", { desc = "Increase Width" })

-- Clear search highlight
map("n", "<Esc>", "<cmd>nohlsearch<CR>", { desc = "Clear Highlights" })

-- =============================================
-- DELETE vs CUT
-- =============================================
-- d/x/c — ЧИСТОЕ удаление: летит в "чёрную дыру" ("_), буфер обмена не трогает.
-- <leader>d / <leader>x — ВЫРЕЗАТЬ: явно кладём в системный буфер обмена ("+).
map({ "n", "x" }, "d", '"_d', { desc = "Delete (no clipboard)" })
map({ "n", "x" }, "D", '"_D', { desc = "Delete to EOL (no clipboard)" })
map({ "n", "x" }, "x", '"_x', { desc = "Delete char (no clipboard)" })
map({ "n", "x" }, "c", '"_c', { desc = "Change (no clipboard)" })
map({ "n", "x" }, "C", '"_C', { desc = "Change to EOL (no clipboard)" })

map({ "n", "x" }, "<leader>d", '"+d', { desc = "Cut (to clipboard)" })
map({ "n", "x" }, "<leader>x", '"+d', { desc = "Cut (to clipboard)" })
map({ "n", "x" }, "<leader>X", '"+D', { desc = "Cut to EOL (to clipboard)" })

-- Вставка поверх выделения не затирает регистр
map("x", "p", '"_dP', { desc = "Вставить без удаления из регистра" })

-- j/k по визуальным строкам, когда включён wrap
map({ "n", "x" }, "j", "v:count == 0 ? 'gj' : 'j'", { expr = true, desc = "Down (visual line)" })
map({ "n", "x" }, "k", "v:count == 0 ? 'gk' : 'k'", { expr = true, desc = "Up (visual line)" })

-- Сдвиг выделения с сохранением выделения
map("x", "<", "<gv", { desc = "Indent Left" })
map("x", ">", ">gv", { desc = "Indent Right" })

-- Перемещение выделенных строк
map("x", "J", ":m '>+1<CR>gv=gv", { desc = "Move Selection Down" })
map("x", "K", ":m '<-2<CR>gv=gv", { desc = "Move Selection Up" })

-- Буферы
map("n", "<S-l>", "<cmd>bnext<CR>", { desc = "Next Buffer" })
map("n", "<S-h>", "<cmd>bprevious<CR>", { desc = "Prev Buffer" })
map("n", "<leader>bd", "<cmd>bdelete<CR>", { desc = "Delete Buffer" })

-- =============================================
-- RESIZE MODE (Pure Lua Submode)
-- =============================================

map("n", "<leader>R", function()
	local function echo()
		vim.api.nvim_echo({ { "-- RESIZE -- (hjkl, q/<Esc> to exit)", "ModeMsg" } }, false, {})
	end

	echo()
	while true do
		local ok, char = pcall(vim.fn.getchar)
		if not ok then
			break -- <C-c> прерывает getchar()
		end
		local c = type(char) == "number" and vim.fn.nr2char(char) or char

		if c == "h" then
			vim.cmd("vertical resize -2")
		elseif c == "l" then
			vim.cmd("vertical resize +2")
		elseif c == "j" then
			vim.cmd("resize -2")
		elseif c == "k" then
			vim.cmd("resize +2")
		elseif c == "q" or c == string.char(27) then -- <Esc>
			break
		end

		vim.cmd("redraw")
		echo()
	end
	vim.api.nvim_echo({ { "", "Normal" } }, false, {})
end, { desc = "Window Resize Mode" })
