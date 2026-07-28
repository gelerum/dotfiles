return {
	-- =============================================
	-- TREESITTER
	-- =============================================
	-- ВАЖНО: ветка master, а не main.
	-- Ветка main требует Neovim >= 0.12 (использует vim.list.unique),
	-- а здесь 0.11.6 — на main install() падает и парсеры не ставятся вообще.
	-- Когда обновишься до 0.12+, можно будет переехать на main.
	{
		"nvim-treesitter/nvim-treesitter",
		branch = "master",
		build = ":TSUpdate",
		lazy = false,
		priority = 1100,
		dependencies = {
			{ "nvim-treesitter/nvim-treesitter-textobjects", branch = "master" },
		},
		config = function()
			-- Модуль называется "configs" (мн. ч.).
			-- "nvim-treesitter.config" — это внутренний модуль ветки main,
			-- его setup() молча проглатывает опции и ничего не включает.
			require("nvim-treesitter.configs").setup({
				ensure_installed = {
					"bash",
					"c",
					"css",
					"diff",
					"dockerfile",
					"gitcommit",
					"gitignore",
					"html",
					"javascript",
					"json",
					"lua",
					"luadoc",
					"markdown",
					"markdown_inline",
					"python",
					"query",
					"regex",
					"toml",
					"tsx",
					"typescript",
					"vim",
					"vimdoc",
					"yaml",
				},
				auto_install = true, -- доставлять парсер для нового языка автоматически
				sync_install = false,

				highlight = { enable = true },
				indent = { enable = true },

				textobjects = {
					select = {
						enable = true,
						lookahead = true,
						keymaps = {
							["af"] = "@function.outer",
							["if"] = "@function.inner",
							["ac"] = "@class.outer",
							["ic"] = "@class.inner",
							["aa"] = "@parameter.outer",
							["ia"] = "@parameter.inner",
						},
					},
					move = {
						enable = true,
						set_jumps = true,
						goto_next_start = { ["]f"] = "@function.outer", ["]c"] = "@class.outer" },
						goto_previous_start = { ["[f"] = "@function.outer", ["[c"] = "@class.outer" },
					},
				},
			})
		end,
	},

	-- =============================================
	-- FUNCTION HEADER (Treesitter Context)
	-- =============================================
	{
		"nvim-treesitter/nvim-treesitter-context",
		event = { "BufReadPost", "BufNewFile" },
		dependencies = { "nvim-treesitter/nvim-treesitter" },
		config = function()
			require("treesitter-context").setup({
				enable = true,
				max_lines = 3, -- сколько строк показывать сверху
				min_window_height = 30,
				line_numbers = true,
				multiline_threshold = 1,
				trim_scope = "outer",
				mode = "cursor", -- "cursor" или "topline"
				separator = "─",
				zindex = 20,
			})
		end,
	},

	-- =============================================
	-- CATPPUCCIN
	-- =============================================
	{
		"catppuccin/nvim",
		name = "catppuccin",
		lazy = false,
		priority = 1000,
		config = function()
			require("catppuccin").setup({
				flavour = "auto",
				background = {
					light = "latte",
					dark = "mocha",
				},
				transparent_background = true,
				integrations = {
					telescope = true,
					nvimtree = true,
					treesitter = true,
					treesitter_context = true,
					cmp = true,
					gitsigns = true,
					mason = true,
					which_key = true,
					native_lsp = { enabled = true },
				},
			})
			vim.cmd.colorscheme("catppuccin")
		end,
	},

	-- =============================================
	-- TELESCOPE
	-- =============================================
	{
		"nvim-telescope/telescope.nvim",
		cmd = "Telescope",
		dependencies = {
			"nvim-lua/plenary.nvim",
			{ "nvim-telescope/telescope-fzf-native.nvim", build = "make" },
			"nvim-tree/nvim-web-devicons",
		},
		config = function()
			local telescope = require("telescope")
			local actions = require("telescope.actions")

			telescope.setup({
				defaults = {
					-- --hidden заставляет ripgrep искать и в скрытых файлах,
					-- при этом .git/ явно исключаем, иначе мусор в выдаче.
					vimgrep_arguments = {
						"rg",
						"--color=never",
						"--no-heading",
						"--with-filename",
						"--line-number",
						"--column",
						"--smart-case",
						"--hidden",
						"--glob=!**/.git/*",
					},
					file_ignore_patterns = {
						"^%.git/",
						"/%.git/",
						"node_modules/",
						"%.venv/",
						"__pycache__/",
					},
					path_display = { "truncate" },
					mappings = {
						i = {
							["<C-k>"] = actions.move_selection_previous,
							["<C-j>"] = actions.move_selection_next,
							["<C-q>"] = actions.send_selected_to_qflist + actions.open_qflist,
							["<C-u>"] = false, -- освобождаем <C-u> для очистки строки поиска
						},
					},
				},
				pickers = {
					-- ГЛАВНОЕ: скрытые файлы (.env, .gitignore, .config/...) теперь видны
					find_files = {
						hidden = true,
						follow = true,
					},
					oldfiles = { hidden = true },
					buffers = {
						sort_mru = true,
						ignore_current_buffer = true,
					},
				},
				extensions = {
					fzf = {},
				},
			})
			telescope.load_extension("fzf")
		end,
	},

	-- =============================================
	-- LUALINE (Beautiful Statusline)
	-- =============================================
	{
		"nvim-lualine/lualine.nvim",
		event = "VeryLazy",
		dependencies = { "nvim-tree/nvim-web-devicons" },
		config = function()
			require("lualine").setup({
				options = {
					theme = "auto", -- Automatically matches your colorscheme!
					globalstatus = true, -- Use one statusline for all windows
				},
			})
		end,
	},

	-- =============================================
	-- GITSIGNS (Git integration in the gutter)
	-- =============================================
	{
		"lewis6991/gitsigns.nvim",
		event = { "BufReadPre", "BufNewFile" },
		config = function()
			require("gitsigns").setup({
				on_attach = function(bufnr)
					local gs = require("gitsigns")
					local function map(mode, lhs, rhs, desc)
						vim.keymap.set(mode, lhs, rhs, { buffer = bufnr, desc = desc })
					end

					map("n", "]h", gs.next_hunk, "Next hunk")
					map("n", "[h", gs.prev_hunk, "Prev hunk")
					map("n", "<leader>hs", gs.stage_hunk, "Stage hunk")
					map("n", "<leader>hr", gs.reset_hunk, "Reset hunk")
					map("n", "<leader>hp", gs.preview_hunk, "Preview hunk")
					map("n", "<leader>hb", function()
						gs.blame_line({ full = true })
					end, "Blame line")
				end,
			})
		end,
	},

	-- =============================================
	-- NVIM-TREE (File Explorer Sidebar)
	-- =============================================
	{
		"nvim-tree/nvim-tree.lua",
		dependencies = {
			"nvim-tree/nvim-web-devicons",
			-- Авто-обновление импортов при переименовании файла из дерева
			{
				"antosha417/nvim-lsp-file-operations",
				dependencies = { "nvim-lua/plenary.nvim" },
				config = true,
			},
		},
		-- Lazy load: плагин не грузится, пока не нажмёшь <leader>e
		cmd = { "NvimTreeToggle", "NvimTreeFindFileToggle" },
		keys = {
			{ "<leader>e", "<cmd>NvimTreeToggle<CR>", desc = "Toggle File Explorer" },
			{ "<leader>E", "<cmd>NvimTreeFindFileToggle<CR>", desc = "Explorer (reveal current file)" },
		},
		config = function()
			require("nvim-tree").setup({
				view = {
					width = 35, -- Width of the sidebar
					side = "left", -- "left" or "right"
				},
				renderer = {
					highlight_git = true, -- Colorize files based on git status
					group_empty = true,
					indent_markers = {
						enable = true, -- Show guide lines for folders
					},
				},
				update_focused_file = {
					enable = true, -- подсвечивать в дереве файл из активного буфера
				},
				actions = {
					open_file = {
						quit_on_open = false,
					},
				},
				-- ГЛАВНОЕ: показываем скрытые И gitignore-нутые файлы.
				-- git_ignored = true (дефолт) прятал, например, .env и .venv.
				filters = {
					dotfiles = false, -- показывать .env, .gitignore и т.п.
					git_ignored = false, -- показывать то, что в .gitignore
					custom = { "^%.git$" }, -- саму папку .git всё же скрываем
				},
				-- Внутри дерева работают переключатели:
				--   H - спрятать/показать dotfiles
				--   I - спрятать/показать gitignore-нутое
				--   U - спрятать/показать custom-фильтр
				--   g? - вся справка по хоткеям
			})
		end,
	},

	-- =============================================
	-- LSP & AUTOCOMPLETION (Святая Троица)
	-- =============================================
	{
		"neovim/nvim-lspconfig",
		event = { "BufReadPre", "BufNewFile" },
		dependencies = {
			-- 1. Mason (Менеджер установок)
			{ "williamboman/mason.nvim", config = true },
			"williamboman/mason-lspconfig.nvim",

			-- 2. Autocompletion (Выпадающее меню nvim-cmp)
			"hrsh7th/nvim-cmp",
			"hrsh7th/cmp-nvim-lsp",
			"hrsh7th/cmp-buffer",
			"hrsh7th/cmp-path",

			-- 3. Сниппеты (cmp требует движок сниппетов)
			"L3MON4D3/LuaSnip",
			"saadparwaiz1/cmp_luasnip",
		},
		config = function()
			require("mason").setup()

			-- Возможности автодополнения для ВСЕХ серверов.
			-- Обязательно ДО mason-lspconfig.setup(), т.к. он сразу вызывает vim.lsp.enable().
			vim.lsp.config("*", {
				capabilities = require("cmp_nvim_lsp").default_capabilities(),
			})

			vim.lsp.config("lua_ls", {
				settings = {
					Lua = {
						diagnostics = { globals = { "vim" } },
						workspace = { checkThirdParty = false },
						telemetry = { enable = false },
					},
				},
			})

			require("mason-lspconfig").setup({
				ensure_installed = { "lua_ls", "basedpyright", "ruff" },
				-- mason-lspconfig v2 сам включает всё установленное через vim.lsp.enable().
				-- stylua — форматтер, а не LSP: без exclude он падает с exit code 2
				-- на каждом .lua файле.
				automatic_enable = {
					exclude = { "stylua", "stylua3p_ls" },
				},
			})

			-- ==========================================
			-- ДИАГНОСТИКА
			-- ==========================================
			vim.diagnostic.config({
				virtual_text = { spacing = 2, prefix = "●" },
				severity_sort = true,
				underline = true,
				update_in_insert = false,
				float = { border = "rounded", source = true },
				signs = {
					text = {
						[vim.diagnostic.severity.ERROR] = " ",
						[vim.diagnostic.severity.WARN] = " ",
						[vim.diagnostic.severity.INFO] = " ",
						[vim.diagnostic.severity.HINT] = " ",
					},
				},
			})

			-- ==========================================
			-- НАСТРОЙКА ВЫПАДАЮЩЕГО МЕНЮ (CMP)
			-- ==========================================
			local cmp = require("cmp")
			local luasnip = require("luasnip")

			cmp.setup({
				snippet = {
					expand = function(args)
						luasnip.lsp_expand(args.body)
					end,
				},
				window = {
					completion = cmp.config.window.bordered(),
					documentation = cmp.config.window.bordered(),
				},
				mapping = cmp.mapping.preset.insert({
					["<C-k>"] = cmp.mapping.select_prev_item(), -- Вверх по меню
					["<C-j>"] = cmp.mapping.select_next_item(), -- Вниз по меню
					["<C-Space>"] = cmp.mapping.complete(), -- Принудительно вызвать меню
					["<C-e>"] = cmp.mapping.abort(),
					["<CR>"] = cmp.mapping.confirm({ select = true }), -- Enter: подтвердить выбор
					-- Tab прыгает по плейсхолдерам сниппета
					["<Tab>"] = cmp.mapping(function(fallback)
						if luasnip.locally_jumpable(1) then
							luasnip.jump(1)
						else
							fallback()
						end
					end, { "i", "s" }),
					["<S-Tab>"] = cmp.mapping(function(fallback)
						if luasnip.locally_jumpable(-1) then
							luasnip.jump(-1)
						else
							fallback()
						end
					end, { "i", "s" }),
				}),
				sources = cmp.config.sources({
					{ name = "nvim_lsp" }, -- Подсказки от языкового сервера
					{ name = "luasnip" }, -- Сниппеты
				}, {
					{ name = "buffer" }, -- Слова из файла
					{ name = "path" }, -- Пути файловой системы
				}),
			})

			-- ==========================================
			-- ХОТКЕИ LSP (только там, где LSP запущен)
			-- ==========================================
			vim.api.nvim_create_autocmd("LspAttach", {
				desc = "LSP Keymaps",
				callback = function(event)
					local bind = function(keys, func, desc)
						vim.keymap.set("n", keys, func, { buffer = event.buf, silent = true, desc = "LSP: " .. desc })
					end
					-- Ленивая обёртка: telescope грузится только при нажатии клавиши
					local function tb(picker)
						return function()
							require("telescope.builtin")[picker]()
						end
					end

					bind("K", vim.lsp.buf.hover, "Hover docs")
					bind("gd", tb("lsp_definitions"), "Goto definition")
					bind("gD", vim.lsp.buf.declaration, "Goto declaration")
					bind("gr", tb("lsp_references"), "References")
					bind("gI", tb("lsp_implementations"), "Goto implementation")
					bind("gy", tb("lsp_type_definitions"), "Type definition")
					bind("<leader>ds", tb("lsp_document_symbols"), "Document symbols")
					bind("<leader>ca", vim.lsp.buf.code_action, "Code action")
					bind("<leader>rn", vim.lsp.buf.rename, "Rename")

					-- Подсветка вхождений слова под курсором
					local client = vim.lsp.get_client_by_id(event.data.client_id)
					if client and client:supports_method("textDocument/documentHighlight") then
						local group = vim.api.nvim_create_augroup("lsp-highlight-" .. event.buf, { clear = true })
						vim.api.nvim_create_autocmd({ "CursorHold", "CursorHoldI" }, {
							buffer = event.buf,
							group = group,
							callback = vim.lsp.buf.document_highlight,
						})
						vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
							buffer = event.buf,
							group = group,
							callback = vim.lsp.buf.clear_references,
						})
					end
				end,
			})
		end,
	},

	-- =============================================
	-- CONFORM (Автоформатирование кода)
	-- =============================================
	{
		"stevearc/conform.nvim",
		event = { "BufWritePre" },
		cmd = { "ConformInfo" },
		keys = {
			{
				"<leader>cf",
				function()
					require("conform").format({ lsp_format = "fallback", async = false, timeout_ms = 1000 })
				end,
				mode = { "n", "v" },
				desc = "Format file or range",
			},
		},
		config = function()
			require("conform").setup({
				-- Привязываем языки к форматтерам
				formatters_by_ft = {
					lua = { "stylua" },
					python = { "ruff_organize_imports", "ruff_format" },
				},

				format_on_save = {
					lsp_format = "fallback",
					timeout_ms = 1000,
				},
			})
		end,
	},

	-- =============================================
	-- AUTO-PAIRS (Автозакрытие скобок и кавычек)
	-- =============================================
	{
		"windwp/nvim-autopairs",
		event = "InsertEnter",
		dependencies = { "hrsh7th/nvim-cmp" },
		config = function()
			require("nvim-autopairs").setup({
				check_ts = true, -- Интеграция с Treesitter (не ставит скобки внутри комментариев)
			})

			-- Связываем автоскобки с выпадающим меню автодополнения (cmp)
			local cmp_autopairs = require("nvim-autopairs.completion.cmp")
			require("cmp").event:on("confirm_done", cmp_autopairs.on_confirm_done())
		end,
	},

	-- =============================================
	-- WHICH-KEY (Всплывающая шпаргалка по хоткеям)
	-- =============================================
	{
		"folke/which-key.nvim",
		event = "VeryLazy",
		opts = {
			spec = {
				{ "<leader>f", group = "find" },
				{ "<leader>g", group = "git" },
				{ "<leader>h", group = "hunk" },
				{ "<leader>c", group = "code" },
				{ "<leader>d", group = "document/diagnostics" },
			},
		},
	},
}
