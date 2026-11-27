use std::fmt::Write;

use crate::cut_svg::{cut_rects, pt_to_mm, CutRect};
use crate::error::{AppError, AppResult};
use crate::layout::create_layout;
use crate::models::PrintSettings;
use crate::scm_cut::has_dxf_fallback;

/// Closed cut paths in millimeters, using DXF's bottom-left origin.
pub fn build_cut_dxf(settings: &PrintSettings) -> AppResult<String> {
    let layout = create_layout(settings)?;
    if let Some(scm) = &layout.scm {
        if !has_dxf_fallback(&scm.name) {
            return Err(AppError::user("Use the SCM .studio3 cutting template"));
        }
    }
    let height = pt_to_mm(layout.height);
    let corner_bulge = -(std::f64::consts::FRAC_PI_8).tan();
    let mut dxf = String::from(
        "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n",
    );
    for CutRect { x0, y0, x1, y1, r } in cut_rects(&layout) {
        let (left, right, top, bottom) = (x0 + r, x1 - r, y0 + r, y1 - r);
        dxf.push_str("0\nLWPOLYLINE\n100\nAcDbEntity\n8\n0\n100\nAcDbPolyline\n90\n8\n70\n1\n");
        for (x, y, bulge) in [
            (left, y0, 0.0),
            (right, y0, corner_bulge),
            (x1, top, 0.0),
            (x1, bottom, corner_bulge),
            (right, y1, 0.0),
            (left, y1, corner_bulge),
            (x0, bottom, 0.0),
            (x0, top, corner_bulge),
        ] {
            writeln!(dxf, "10\n{x:.6}\n20\n{:.6}\n42\n{bulge:.9}", height - y).unwrap();
        }
    }
    dxf.push_str("0\nENDSEC\n0\nEOF\n");
    Ok(dxf)
}
