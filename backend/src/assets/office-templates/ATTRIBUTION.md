# Blank office documents

`new.docx`, `new.xlsx` and `new.pptx` are the empty documents a new office file
is created from. They are copied verbatim from
[ONLYOFFICE/document-templates](https://github.com/ONLYOFFICE/document-templates)
(`new/default/`), which is licensed under Apache-2.0.

They are kept as files rather than generated because a minimal OOXML package
written by hand is only *nearly* valid: editors accept some of them and quietly
repair or reject others, and the failure shows up as an unopenable document
rather than as a build error.

The upstream repository also ships localised variants (`new/fr-FR/` and so on),
which differ in the default sheet name and document language. Adding one is a
matter of dropping the files in beside these and selecting them by locale;
`default` is used for every language until then.
