" Groovy даёт базовую подсветку; диагностику и форматирование делает Nextflow LSP.
if exists('b:current_syntax')
  finish
endif
runtime! syntax/groovy.vim
syntax keyword nextflowKeyword process workflow include params publish output
highlight default link nextflowKeyword Keyword
let b:current_syntax = 'nextflow'
