# What is checked

- X12: the width of every ISA field, ISA13 against IEA02, GS06 against GE02, ST02 against SE02, the number of groups, transaction sets and segments.
- EDIFACT: UNB and UNZ, UNG and UNE, UNH and UNT references and counts.
- Segments that do not belong to the transaction set or message type (850, 810, 856, 837, 835, ORDERS, INVOIC, DESADV and more).
- Mandatory elements that are empty.

Problems show in the viewer's Problems tab and in VS Code's Problems panel for the text editor.
