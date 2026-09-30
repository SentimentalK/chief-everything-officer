//! Shared human-output rendering helpers.
//!
//! Human output is vertical/block oriented: long UUIDs, paths, and errors
//! each get their own line. No fixed-width tables, no color/TUI dependency.

/// Appends one line with the given indentation.
pub fn push_line(out: &mut String, indent: usize, text: &str) {
    for _ in 0..indent {
        out.push(' ');
    }
    out.push_str(text);
    out.push('\n');
}

/// Appends `Label: value` on its own line with the given indentation.
pub fn push_field(out: &mut String, indent: usize, label: &str, value: &str) {
    for _ in 0..indent {
        out.push(' ');
    }
    out.push_str(label);
    out.push_str(": ");
    out.push_str(value);
    out.push('\n');
}

/// Appends `Label: value` when `value` is `Some`, otherwise
/// `Label: <default>` on its own line with the given indentation.
pub fn push_opt_field(out: &mut String, indent: usize, label: &str, value: &Option<String>) {
    match value {
        Some(v) => push_field(out, indent, label, v),
        None => push_field(out, indent, label, "<none>"),
    }
}

/// Appends a multi-line value under a `Label:` header line, one line per
/// source line, so long text never breaks alignment (there is none).
pub fn push_multiline_field(out: &mut String, indent: usize, label: &str, text: &str) {
    for _ in 0..indent {
        out.push(' ');
    }
    out.push_str(label);
    out.push(':');
    out.push('\n');
    for line in text.lines() {
        for _ in 0..(indent + 2) {
            out.push(' ');
        }
        out.push_str(line);
        out.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers_render_vertical_fields() {
        let mut out = String::new();
        push_line(&mut out, 0, "Job: job-1");
        push_field(&mut out, 2, "State", "running");
        push_opt_field(&mut out, 2, "Expires", &None);
        push_opt_field(&mut out, 2, "Error", &Some("boom".into()));
        push_multiline_field(&mut out, 2, "Prompt", "line one\nline two");

        assert_eq!(
            out,
            "Job: job-1\n  State: running\n  Expires: <none>\n  Error: boom\n  Prompt:\n    line one\n    line two\n"
        );
    }
}
