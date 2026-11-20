package com.xxhh.xhc;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极简 JSON（只给 Hub 用，零依赖）。
 * 解析产出 Map<String,Object> / List<Object> / String / Long / Double / Boolean / null。
 * 只用于协议帧，不追求通用规范（RFC 8259 的常见子集：对象、数组、字符串、数字、true/false/null、uXXXX）。
 */
public final class Json {

    private Json() {
    }

    public static Object parse(String text) {
        Parser p = new Parser(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != text.length()) {
            throw new IllegalArgumentException("trailing garbage at " + p.i);
        }
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> asObject(Object o) {
        if (!(o instanceof Map)) {
            throw new IllegalArgumentException("not an object");
        }
        return (Map<String, Object>) o;
    }

    public static String str(Object o) {
        return o instanceof String ? (String) o : null;
    }

    public static long lng(Object o, long def) {
        if (o instanceof Long) {
            return ((Long) o).longValue();
        }
        if (o instanceof Double) {
            return ((Double) o).longValue();
        }
        if (o instanceof String) {
            try {
                return Long.parseLong((String) o);
            } catch (NumberFormatException ignored) {
                return def;
            }
        }
        return def;
    }

    /** 把字符串写成 JSON 字面量（含引号）。 */
    public static String quote(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder b = new StringBuilder(s.length() + 2);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    b.append("\\\"");
                    break;
                case '\\':
                    b.append("\\\\");
                    break;
                case '\n':
                    b.append("\\n");
                    break;
                case '\r':
                    b.append("\\r");
                    break;
                case '\t':
                    b.append("\\t");
                    break;
                case '\b':
                    b.append("\\b");
                    break;
                case '\f':
                    b.append("\\f");
                    break;
                default:
                    if (c < 0x20 || c == 0x7f) {
                        b.append("\\u");
                        b.append(HEX[(c >> 12) & 0xf]);
                        b.append(HEX[(c >> 8) & 0xf]);
                        b.append(HEX[(c >> 4) & 0xf]);
                        b.append(HEX[c & 0xf]);
                    } else {
                        b.append(c);
                    }
            }
        }
        b.append('"');
        return b.toString();
    }

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private static final class Parser {
        private final String s;
        private int i;

        Parser(String s) {
            this.s = s;
        }

        void ws() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    i++;
                } else {
                    break;
                }
            }
        }

        char peek() {
            if (i >= s.length()) {
                throw new IllegalArgumentException("unexpected end");
            }
            return s.charAt(i);
        }

        void expect(char c) {
            if (peek() != c) {
                throw new IllegalArgumentException("expected '" + c + "' at " + i);
            }
            i++;
        }

        Object value() {
            char c = peek();
            switch (c) {
                case '{':
                    return object();
                case '[':
                    return array();
                case '"':
                    return string();
                case 't':
                    literal("true");
                    return Boolean.TRUE;
                case 'f':
                    literal("false");
                    return Boolean.FALSE;
                case 'n':
                    literal("null");
                    return null;
                default:
                    return number();
            }
        }

        void literal(String word) {
            if (!s.startsWith(word, i)) {
                throw new IllegalArgumentException("bad literal at " + i);
            }
            i += word.length();
        }

        Map<String, Object> object() {
            expect('{');
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            ws();
            if (peek() == '}') {
                i++;
                return m;
            }
            while (true) {
                ws();
                String k = string();
                ws();
                expect(':');
                ws();
                m.put(k, value());
                ws();
                char c = peek();
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == '}') {
                    i++;
                    return m;
                }
                throw new IllegalArgumentException("expected , or } at " + i);
            }
        }

        List<Object> array() {
            expect('[');
            List<Object> a = new ArrayList<Object>();
            ws();
            if (peek() == ']') {
                i++;
                return a;
            }
            while (true) {
                ws();
                a.add(value());
                ws();
                char c = peek();
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == ']') {
                    i++;
                    return a;
                }
                throw new IllegalArgumentException("expected , or ] at " + i);
            }
        }

        String string() {
            expect('"');
            StringBuilder b = new StringBuilder();
            while (true) {
                if (i >= s.length()) {
                    throw new IllegalArgumentException("unterminated string");
                }
                char c = s.charAt(i++);
                if (c == '"') {
                    return b.toString();
                }
                if (c == '\\') {
                    if (i >= s.length()) {
                        throw new IllegalArgumentException("bad escape");
                    }
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"':
                            b.append('"');
                            break;
                        case '\\':
                            b.append('\\');
                            break;
                        case '/':
                            b.append('/');
                            break;
                        case 'b':
                            b.append('\b');
                            break;
                        case 'f':
                            b.append('\f');
                            break;
                        case 'n':
                            b.append('\n');
                            break;
                        case 'r':
                            b.append('\r');
                            break;
                        case 't':
                            b.append('\t');
                            break;
                        case 'u':
                            if (i + 4 > s.length()) {
                                throw new IllegalArgumentException("bad \\u escape");
                            }
                            int cp = 0;
                            for (int k = 0; k < 4; k++) {
                                cp = (cp << 4) | Character.digit(s.charAt(i++), 16);
                            }
                            if (cp < 0) {
                                throw new IllegalArgumentException("bad \\u escape");
                            }
                            b.append((char) cp);
                            break;
                        default:
                            throw new IllegalArgumentException("bad escape \\" + e);
                    }
                } else {
                    b.append(c);
                }
            }
        }

        Object number() {
            int start = i;
            if (peek() == '-') {
                i++;
            }
            boolean digits = false;
            while (i < s.length() && Character.isDigit(s.charAt(i))) {
                i++;
                digits = true;
            }
            if (!digits) {
                throw new IllegalArgumentException("bad number at " + start);
            }
            boolean integral = true;
            if (i < s.length() && s.charAt(i) == '.') {
                integral = false;
                i++;
                while (i < s.length() && Character.isDigit(s.charAt(i))) {
                    i++;
                }
            }
            if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                integral = false;
                i++;
                if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) {
                    i++;
                }
                while (i < s.length() && Character.isDigit(s.charAt(i))) {
                    i++;
                }
            }
            String raw = s.substring(start, i);
            if (integral) {
                return Long.valueOf(Long.parseLong(raw));
            }
            return Double.valueOf(Double.parseDouble(raw));
        }
    }
}