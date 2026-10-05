# markdownlint (mdl) rules for this repository; `npm run check:markdown` runs
# them over every tracked Markdown file except CHANGELOG.md.
all
rule 'MD013', :line_length => 80, :tables => false, :ignore_code_blocks => true
rule 'MD024', :allow_different_nesting => true
rule 'MD007', :indent => 2
# Staging lists keep their step numbers after a step is built and removed,
# because other docs cite them by number.
exclude_rule 'MD029'
# `<callsign>`-style placeholders read as inline HTML.
exclude_rule 'MD033'
# URLs inside code spans are reported as bare.
exclude_rule 'MD034'
# `*` inside fenced code is reported as emphasis.
exclude_rule 'MD037'
