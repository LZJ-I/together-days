/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ["./index.html"],
    theme: {
        extend: {
            colors: {
                love: {
                    light: "#FFB6C1",
                    DEFAULT: "#FF69B4",
                    dark: "#C71585"
                }
            },
            fontFamily: {
                romantic: ["Dancing Script", "cursive", "sans-serif"]
            }
        }
    },
    plugins: []
};
