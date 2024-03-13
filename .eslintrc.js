module.exports = {
    env: {
        browser: true,
        es2021: true,
    },
    extends: "standard-with-typescript",
    overrides: [
        {
            env: {
                node: true,
            },
            files: [".eslintrc.js"],
            parserOptions: {
                sourceType: "script",
            },
        },
    ],
    parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
    },
    rules: {
        curly: [2, "all"],
        "keyword-spacing": [2, {}],
        "no-with": 2,
        "space-before-blocks": [2, "always"],
        "space-before-function-paren": [
            2,
            {
                anonymous: "ignore",
                named: "never",
            },
        ],
        "one-var": [2, "never"],
        "no-multiple-empty-lines": 2,
        "array-bracket-spacing": [
            2,
            "always",
            {
                objectsInArrays: false,
            },
        ],
        "quote-props": [
            2,
            "as-needed",
            {
                keywords: true,
            },
        ],
        "key-spacing": [
            2,
            {
                beforeColon: false,
                afterColon: true,
            },
        ],
        "comma-style": [2, "last"],
        "space-unary-ops": [
            2,
            {
                words: false,
                nonwords: false,
            },
        ],
        "space-infix-ops": 2,
        "no-mixed-spaces-and-tabs": 2,
        "no-trailing-spaces": 2,
        "comma-dangle": [2, "never"],
        "eol-last": 2,
        yoda: [2, "never"],
        "spaced-comment": [2, "always"],
        indent: ["off"],
    },
};
