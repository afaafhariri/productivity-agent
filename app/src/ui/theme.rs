//! The "Orbital" look: bundled fonts, the gpui-component theme, and the few accent colours
//! the theme's colour slots don't cover (the cyan→violet gradient, amber for approvals).
//!
//! Designs live in the Stitch project "Productivity Agent". Fonts are Sora and JetBrains Mono,
//! both SIL Open Font License (licences in `assets/fonts/`).

use std::borrow::Cow;
use std::rc::Rc;

use gpui_kit::component::{Theme, ThemeSet};
use gpui_kit::*;

const FONTS: [&[u8]; 5] = [
    include_bytes!("../../assets/fonts/Sora-Light.ttf"),
    include_bytes!("../../assets/fonts/Sora-Regular.ttf"),
    include_bytes!("../../assets/fonts/Sora-SemiBold.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-Medium.ttf"),
];

const ORBITAL_THEME: &str = include_str!("../../assets/themes/orbital.json");

/// Registers the bundled fonts and switches the app to the Orbital theme.
/// Call once, after `gpui_kit::init`.
pub fn install(cx: &mut App) {
    let fonts = FONTS.iter().map(|bytes| Cow::Borrowed(*bytes)).collect();
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        // Text still renders with the platform fallback font.
        eprintln!("failed to load bundled fonts: {error:#}");
    }

    let config = Rc::new(orbital_config());
    Theme::update(cx, |theme| theme.apply_config(&config));
}

fn orbital_config() -> gpui_kit::component::ThemeConfig {
    let set: ThemeSet = serde_json::from_str(ORBITAL_THEME).expect("orbital.json is valid");
    set.themes
        .into_iter()
        .next()
        .expect("orbital.json has one theme")
}

/// Accent colours outside the theme's own slots.
pub mod palette {
    use gpui_kit::{Hsla, rgb};

    /// Top bar, panels, code blocks.
    pub fn surface_1() -> Hsla {
        rgb(0x0C1017).into()
    }

    /// Cards, inputs, user bubbles.
    pub fn surface_2() -> Hsla {
        rgb(0x131A24).into()
    }

    pub fn cyan() -> Hsla {
        rgb(0x22D3EE).into()
    }

    pub fn violet() -> Hsla {
        rgb(0x8B5CF6).into()
    }

    /// Text on the gradient and on amber buttons.
    pub fn ink() -> Hsla {
        rgb(0x07090E).into()
    }

    /// Hints and other low-emphasis text.
    pub fn faint() -> Hsla {
        rgb(0x566175).into()
    }
}

/// The signature cyan→violet gradient (`angle` in degrees, 0 = to top, clockwise).
pub fn accent_gradient(angle: f32) -> Background {
    linear_gradient(
        angle,
        linear_color_stop(palette::cyan(), 0.),
        linear_color_stop(palette::violet(), 1.),
    )
}

/// The app's logo mark: a small rounded square in the accent gradient with a dark core.
pub fn logo_mark(size: Pixels) -> Div {
    div()
        .size(size)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(size * 0.3)
        .bg(accent_gradient(135.))
        .child(div().size(size * 0.3).rounded_full().bg(palette::ink()))
}

#[cfg(test)]
mod tests {
    // No glob imports: gpui_kit re-exports `gpui` and `test` (see chat.rs tests).
    use gpui_kit::TestAppContext;
    use gpui_kit::component::ActiveTheme as _;

    use super::{install, orbital_config};

    #[gpui::test]
    fn install_switches_to_the_orbital_theme(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            install(cx);
            let theme = cx.theme();
            assert!(theme.is_dark());
            assert_eq!(theme.theme_name().as_ref(), "Orbital");
            assert_eq!(theme.font_family.as_ref(), "Sora");
            assert_eq!(theme.mono_font_family.as_ref(), "JetBrains Mono");
        });
    }

    #[test]
    fn orbital_theme_parses_as_a_dark_theme_with_bundled_fonts() {
        let config = orbital_config();
        assert_eq!(config.name.as_ref(), "Orbital");
        assert!(config.mode.is_dark());
        assert_eq!(config.font_family.as_deref(), Some("Sora"));
        assert_eq!(config.mono_font_family.as_deref(), Some("JetBrains Mono"));
    }
}
