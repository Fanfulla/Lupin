// Assisted model input (design 2026-08-13): the one widget used wherever a
// model id is typed (quick-model, the slot editor, an agent's model target).
// Typing filters the provider's catalogue live; pasting lands atomically
// (bracketed paste); an id outside the catalogue is accepted with an advisory
// in the talking line, never refused: the catalogue informs, it never gates
// (ADR-42). No catalogue at all means a plain text field, not an error.

use crate::api::CatalogModel;

/// The filtered list never grows past this: the overlay must stay a glance.
pub const MAX_ROWS: usize = 8;

pub struct ModelInput {
    pub text: String,
    /// None = no catalogue for this provider (or the fetch failed).
    pub catalog: Option<Vec<CatalogModel>>,
    /// 0 = the typed text itself; 1..=filtered().len() = a catalogue row.
    pub cursor: usize,
}

impl ModelInput {
    pub fn new(catalog: Option<Vec<CatalogModel>>) -> Self {
        Self {
            text: String::new(),
            catalog,
            cursor: 0,
        }
    }

    pub fn type_char(&mut self, c: char) {
        if !c.is_control() {
            self.text.push(c);
            self.cursor = 0;
        }
    }

    pub fn backspace(&mut self) {
        self.text.pop();
        self.cursor = 0;
    }

    /// A paste is one gesture: control characters (newlines included) are
    /// stripped, so a copied line always lands as a single clean id.
    pub fn paste(&mut self, s: &str) {
        self.text.extend(s.chars().filter(|c| !c.is_control()));
        self.cursor = 0;
    }

    pub fn up(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn down(&mut self) {
        if self.cursor < self.filtered().len() {
            self.cursor += 1;
        }
    }

    /// Case-insensitive substring match on id and display name, first
    /// MAX_ROWS. An empty text shows the head of the catalogue: the list is
    /// browsable before the first keystroke.
    pub fn filtered(&self) -> Vec<&CatalogModel> {
        let Some(catalog) = &self.catalog else {
            return Vec::new();
        };
        let needle = self.text.trim().to_lowercase();
        catalog
            .iter()
            .filter(|m| {
                needle.is_empty()
                    || m.id.to_lowercase().contains(&needle)
                    || m.name
                        .as_deref()
                        .is_some_and(|n| n.to_lowercase().contains(&needle))
            })
            .take(MAX_ROWS)
            .collect()
    }

    /// What Enter takes: the highlighted catalogue row's id, or the typed
    /// text verbatim when the cursor sits on the text row.
    pub fn accept(&self) -> String {
        match self.accepted_row() {
            Some(m) => m.id.clone(),
            None => self.text.trim().to_string(),
        }
    }

    /// The catalogue row the accepted id names, if any: the highlighted row,
    /// or an exact id match for pasted text. This is where the context window
    /// for the §4quater autofill comes from.
    pub fn accepted_row(&self) -> Option<&CatalogModel> {
        if self.cursor > 0 {
            return self.filtered().into_iter().nth(self.cursor - 1);
        }
        let text = self.text.trim();
        self.catalog
            .as_ref()?
            .iter()
            .find(|m| m.id == text)
    }

    /// Some when a catalogue is loaded and the accepted id is not in it: the
    /// advisory for the talking line. Never a refusal (a brand-new model may
    /// not be listed yet).
    pub fn advisory(&self) -> Option<String> {
        let catalog = self.catalog.as_ref()?;
        let id = self.accept();
        if id.is_empty() || catalog.iter().any(|m| m.id == id) {
            None
        } else {
            Some(format!("\"{id}\" is not in the provider's catalogue: written as given"))
        }
    }
}

/// `262144 -> "262k"`, `1000000 -> "1.0M"`: the compact window label for a row.
pub fn window_label(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{}k", tokens / 1_000)
    } else {
        tokens.to_string()
    }
}

/// One catalogue row as the overlay prints it: id, window, the tools verdict
/// (silence when the catalogue does not say), and USD per million tokens.
pub fn row_label(m: &CatalogModel) -> String {
    let mut s = format!(" {}", m.id);
    if let Some(w) = m.context_window {
        s.push_str(&format!("  {} ctx", window_label(w)));
    }
    match m.supports_tools {
        Some(true) => s.push_str("  tools"),
        Some(false) => s.push_str("  NO TOOLS"),
        None => {}
    }
    if let (Some(p), Some(c)) = (m.prompt_price, m.completion_price) {
        s.push_str(&format!("  ${:.2}/${:.2} per M", p * 1e6, c * 1e6));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::{row_label, window_label, ModelInput};
    use crate::api::CatalogModel;

    fn model(id: &str, name: Option<&str>) -> CatalogModel {
        CatalogModel {
            id: id.to_string(),
            name: name.map(String::from),
            context_window: Some(262_144),
            supports_tools: Some(true),
            prompt_price: Some(0.000_000_5),
            completion_price: Some(0.000_002_5),
        }
    }

    fn catalog() -> Vec<CatalogModel> {
        vec![
            model("vendor/alpha", Some("Alpha One")),
            model("vendor/beta", Some("Beta Two")),
            model("other/gamma", None),
        ]
    }

    #[test]
    fn typing_filters_on_id_and_name_case_insensitively() {
        let mut input = ModelInput::new(Some(catalog()));
        for c in "ALPHA".chars() {
            input.type_char(c);
        }
        let ids: Vec<&str> = input.filtered().iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["vendor/alpha"]);
        input.text.clear();
        input.text.push_str("two");
        assert_eq!(input.filtered().len(), 1);
        assert_eq!(input.filtered()[0].id, "vendor/beta");
    }

    #[test]
    fn empty_text_shows_the_catalogue_head_capped() {
        let many: Vec<CatalogModel> = (0..20)
            .map(|i| model(&format!("vendor/m{i}"), None))
            .collect();
        let input = ModelInput::new(Some(many));
        assert_eq!(input.filtered().len(), super::MAX_ROWS);
    }

    #[test]
    fn accept_returns_typed_text_without_a_selection_and_the_row_id_with_one() {
        let mut input = ModelInput::new(Some(catalog()));
        input.paste("brand-new/model");
        assert_eq!(input.accept(), "brand-new/model");
        input.text.clear();
        input.down();
        assert_eq!(input.cursor, 1);
        assert_eq!(input.accept(), "vendor/alpha");
    }

    #[test]
    fn paste_strips_control_characters_and_trims_on_accept() {
        let mut input = ModelInput::new(None);
        input.paste("  vendor/alpha\r\n");
        assert_eq!(input.text, "  vendor/alpha");
        assert_eq!(input.accept(), "vendor/alpha");
    }

    #[test]
    fn accepted_row_finds_an_exact_id_match_for_pasted_text() {
        let mut input = ModelInput::new(Some(catalog()));
        input.paste("vendor/beta");
        let row = input.accepted_row().expect("exact match");
        assert_eq!(row.id, "vendor/beta");
        assert_eq!(row.context_window, Some(262_144));
    }

    #[test]
    fn advisory_only_for_an_off_catalogue_id() {
        let mut input = ModelInput::new(Some(catalog()));
        input.paste("vendor/alpha");
        assert_eq!(input.advisory(), None);
        input.text.clear();
        input.paste("unknown/model");
        assert!(input.advisory().is_some());
        let mut plain = ModelInput::new(None);
        plain.paste("anything/goes");
        assert_eq!(plain.advisory(), None, "no catalogue means no judgement");
    }

    #[test]
    fn cursor_stays_inside_the_filtered_range_and_resets_on_typing() {
        let mut input = ModelInput::new(Some(catalog()));
        input.down();
        input.down();
        input.down();
        input.down();
        assert_eq!(input.cursor, 3, "clamped at the last row");
        input.type_char('x');
        assert_eq!(input.cursor, 0, "typing goes back to the text row");
        input.up();
        assert_eq!(input.cursor, 0);
    }

    #[test]
    fn labels_are_compact_and_honest() {
        assert_eq!(window_label(262_144), "262k");
        assert_eq!(window_label(1_000_000), "1.0M");
        assert_eq!(window_label(512), "512");
        let label = row_label(&model("vendor/alpha", None));
        assert!(label.contains("vendor/alpha"));
        assert!(label.contains("262k ctx"));
        assert!(label.contains("tools"));
        assert!(label.contains("$0.50/$2.50 per M"));
        let mut no_tools = model("x/y", None);
        no_tools.supports_tools = Some(false);
        assert!(row_label(&no_tools).contains("NO TOOLS"));
    }
}
