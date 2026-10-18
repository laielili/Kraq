/** @type {import('stylelint').Config} */
export default {
  extends: 'stylelint-config-standard',
  rules: {
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: ['tailwind', 'apply', 'layer', 'theme', 'custom-variant'],
      },
    ],
    // Tailwind 4 的 @apply 使用 CSS 内注册的 utility（border-border 等），
    // stylelint 无法解析其 prelude，属已知不兼容
    'at-rule-prelude-no-invalid': null,
    'hue-degree-notation': null,
    'import-notation': null,
    'lightness-notation': null,
    'rule-empty-line-before': null,
    'value-keyword-case': null,
  },
};
