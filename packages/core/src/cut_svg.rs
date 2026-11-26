use std::fmt::Write;

use crate::error::{AppError, AppResult};
use crate::layout::create_layout;
use crate::models::{LayoutMode, PrintSettings};
use crate::raster::CORNER_RADIUS_MM;

fn pt_to_mm(pt: f64) -> f64 {
    pt * 25.4 / 72.0
}

/// A reusable cutting template for a free-layout sheet, in millimeters.
pub fn build_cut_svg(settings: &PrintSettings) -> AppResult<String> {
    if settings.layout_mode != LayoutMode::Free {
        return Err(AppError::user("Use the SCM .studio3 cutting template"));
    }
    let layout = create_layout(settings)?;
    let width = pt_to_mm(layout.width);
    let height = pt_to_mm(layout.height);
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width:.6}mm\" height=\"{height:.6}mm\" viewBox=\"0 0 {width:.6} {height:.6}\">\n"
    );
    for slot in layout.slots {
        let trim = slot.trim;
        let x0 = pt_to_mm(trim.x);
        let y0 = pt_to_mm(trim.y);
        let x1 = pt_to_mm(trim.x + trim.width);
        let y1 = pt_to_mm(trim.y + trim.height);
        let r = CORNER_RADIUS_MM.min((x1 - x0).min(y1 - y0) / 2.0);
        let left = x0 + r;
        let right = x1 - r;
        let top = y0 + r;
        let bottom = y1 - r;
        writeln!(
            svg,
            "  <path fill=\"none\" stroke=\"black\" stroke-width=\"0.1\" d=\"M {left:.6} {y0:.6} H {right:.6} A {r:.6} {r:.6} 0 0 1 {x1:.6} {top:.6} V {bottom:.6} A {r:.6} {r:.6} 0 0 1 {right:.6} {y1:.6} H {left:.6} A {r:.6} {r:.6} 0 0 1 {x0:.6} {bottom:.6} V {top:.6} A {r:.6} {r:.6} 0 0 1 {left:.6} {y0:.6} Z\"/>"
        )
        .unwrap();
    }
    svg.push_str("</svg>\n");
    Ok(svg)
}
