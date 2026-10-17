#!/usr/bin/env python3
"""
Author a continuous faceted Oct 2026 Tesla Roadster as a closed GLB.

Blender is Z-up. We author: +X nose, +Z up, +Y left.
export_yup=True maps that to glTF/three.js: +X nose, +Y up, +Z left.

blender --background --python build_roadster_2026.py
Target ~4.3×1.2×2.0 m, < 1 MB.
"""
import bpy
import bmesh
import math
import os
from mathutils import Vector, Matrix

OUT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../assets/models/tesla-roadster-2026.glb")
)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for b in list(block):
            block.remove(b)


def make_mat(name, color, metal=0.35, rough=0.32, emission=None, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Roughness"].default_value = rough
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.45
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission[0], 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission[1]
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        m.blend_method = "BLEND"
        m.shadow_method = "HASHED"
        if "Transmission Weight" in bsdf.inputs:
            bsdf.inputs["Transmission Weight"].default_value = 0.12
    return m


def apply_object(obj):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.select_set(False)


def shade_flat(obj):
    for p in obj.data.polygons:
        p.use_smooth = False


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def mesh_from_bm(name, bm, mat):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    shade_flat(obj)
    return obj


def profile_half(bottom, top, half_w, arch=0.0):
    """Half-profile in Z-up / +Y side: (z_height, y_left). Always same count."""
    lift = arch * 0.38
    bot = bottom + lift * 0.1
    hw = half_w * (1.0 - arch * 0.06)
    return [
        (bot, 0.0),
        (bot + lift * 0.25, hw * 0.40),
        (bot + 0.04 + lift, hw * 0.72),
        (bottom + (top - bottom) * 0.30 + lift * 0.15, hw),
        (bottom + (top - bottom) * 0.52, hw * 0.97),
        (top - 0.06, hw * 0.68),
        (top, hw * 0.30),
        (top, 0.0),
    ]


def build_loft_body(name, stations, mat, do_bevel=True):
    """stations: [(x, bottom_z, top_z, half_y, arch), ...] — Blender Z-up."""
    half_pts = [profile_half(b, t, w, a) for (_, b, t, w, a) in stations]
    n_half = len(half_pts[0])
    assert all(len(h) == n_half for h in half_pts)

    def full_ring(x, half):
        # +Y half (incl centerline), then -Y interior
        pts = [Vector((x, y, z)) for (z, y) in half]
        for z, y in reversed(half[1:-1]):
            pts.append(Vector((x, -y, z)))
        return pts

    rings_pts = [full_ring(stations[i][0], half_pts[i]) for i in range(len(stations))]
    n = len(rings_pts[0])

    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in ring] for ring in rings_pts]
    bm.verts.ensure_lookup_table()

    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for j in range(n):
            j2 = (j + 1) % n
            bm.faces.new([a[j], a[j2], b[j2], b[j]])

    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    if do_bevel:
        bm.edges.ensure_lookup_table()
        sharp = []
        for e in bm.edges:
            if len(e.link_faces) != 2:
                continue
            try:
                if e.calc_face_angle() > math.radians(32):
                    sharp.append(e)
            except ValueError:
                pass
        if sharp:
            bmesh.ops.bevel(bm, geom=sharp, offset=0.008, segments=1, affect="EDGES")
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    nonman = sum(1 for e in bm.edges if not e.is_manifold)
    print(f"  {name}: verts={len(bm.verts)} faces={len(bm.faces)} nonmanifold={nonman}")
    return mesh_from_bm(name, bm, mat)


def add_wheel_wells(black):
    for ax, ay in [(1.28, 0.86), (1.28, -0.86), (-1.32, 0.86), (-1.32, -0.86)]:
        # Cylinder axis along Y (into the arch)
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.34, depth=0.09, location=(ax, ay, 0.34), rotation=(math.pi / 2, 0, 0), vertices=20
        )
        well = bpy.context.active_object
        well.name = f"WheelWell_{ax}_{ay}"
        well.scale = (1.0, 0.55, 1.0)
        apply_object(well)
        well.data.materials.append(black)
        shade_smooth(well)


def build_body_shell(paint, black):
    stations = [
        (2.16, 0.18, 0.28, 0.11, 0.0),
        (2.00, 0.12, 0.34, 0.38, 0.0),
        (1.78, 0.09, 0.40, 0.70, 0.0),
        (1.55, 0.08, 0.46, 0.92, 0.25),
        (1.28, 0.08, 0.50, 0.98, 1.0),
        (1.02, 0.08, 0.52, 1.00, 0.25),
        (0.65, 0.08, 0.54, 1.00, 0.0),
        (0.30, 0.08, 0.74, 0.98, 0.0),
        (0.00, 0.08, 0.98, 0.94, 0.0),
        (-0.32, 0.08, 1.08, 0.90, 0.0),
        (-0.65, 0.08, 1.04, 0.90, 0.0),
        (-0.95, 0.08, 0.90, 0.93, 0.0),
        (-1.15, 0.08, 0.70, 0.96, 0.25),
        (-1.32, 0.08, 0.56, 0.98, 1.0),
        (-1.52, 0.08, 0.50, 0.98, 0.25),
        (-1.80, 0.10, 0.46, 0.96, 0.0),
        (-2.02, 0.12, 0.40, 0.92, 0.0),
        (-2.12, 0.14, 0.36, 0.88, 0.0),
    ]
    body = build_loft_body("BodyShell", stations, paint, do_bevel=True)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    body.select_set(False)
    add_wheel_wells(black)
    print(f"  BodyShell dims {[round(d,3) for d in body.dimensions]}")
    return body


def add_lower_cladding(black):
    stations = [
        (2.08, 0.04, 0.18, 0.48, 0.0),
        (1.70, 0.04, 0.20, 0.88, 0.0),
        (1.28, 0.04, 0.20, 0.70, 0.9),
        (0.60, 0.04, 0.20, 0.96, 0.0),
        (-0.40, 0.04, 0.20, 0.96, 0.0),
        (-1.32, 0.04, 0.20, 0.70, 0.9),
        (-1.70, 0.04, 0.20, 0.92, 0.0),
        (-2.08, 0.05, 0.22, 0.86, 0.0),
    ]
    return build_loft_body("LowerCladding", stations, black, do_bevel=False)


def add_canopy(glass):
    """Single closed flush canopy volume — opaque dark glass, no panel gaps."""
    bm = bmesh.new()
    # Simpler prism tightly nested into the body shoulder
    coords = [
        # windshield base
        (0.55, 0.78, 0.58),
        (0.55, -0.78, 0.58),
        # windshield top / roof front
        (-0.05, 0.58, 1.02),
        (-0.05, -0.58, 1.02),
        # roof rear
        (-0.85, 0.52, 0.98),
        (-0.85, -0.52, 0.98),
        # rear glass base
        (-1.12, 0.72, 0.68),
        (-1.12, -0.72, 0.68),
    ]
    vs = [bm.verts.new(c) for c in coords]
    faces = [
        (0, 1, 3, 2),  # windshield
        (2, 3, 5, 4),  # roof
        (4, 5, 7, 6),  # rear
        (0, 2, 4, 6),  # left
        (1, 7, 5, 3),  # right
        (0, 6, 7, 1),  # bottom seal
    ]
    for f in faces:
        bm.faces.new([vs[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.edges.ensure_lookup_table()
    sharp = [e for e in bm.edges if e.calc_face_angle(0) > math.radians(18)]
    if sharp:
        bmesh.ops.bevel(bm, geom=sharp, offset=0.012, segments=1, affect="EDGES")
    obj = mesh_from_bm("Canopy", bm, glass)
    shade_smooth(obj)
    return obj


def add_wing(paint, black):
    # Struts from rear deck up into the wing plate (no gap)
    for y in (-0.42, 0.42):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(-1.72, y, 0.78))
        s = bpy.context.active_object
        s.name = f"WingStrut_{'L' if y > 0 else 'R'}"
        s.scale = (0.055, 0.045, 0.52)  # top ~1.04, meets wing underside
        apply_object(s)
        s.data.materials.append(paint)
        shade_flat(s)

    bpy.ops.mesh.primitive_cube_add(size=1, location=(-1.90, 0, 1.08))
    w = bpy.context.active_object
    w.name = "RearWing"
    w.scale = (0.38, 1.05, 0.045)  # ~2.1 m wide
    w.rotation_euler[1] = math.radians(10)
    apply_object(w)
    bpy.ops.object.modifier_add(type="BEVEL")
    w.modifiers["Bevel"].width = 0.01
    w.modifiers["Bevel"].segments = 1
    bpy.ops.object.modifier_apply(modifier="Bevel")
    w.data.materials.append(paint)
    shade_flat(w)

    # Endplates flush on wing tips
    for y in (-0.525, 0.525):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(-1.90, y, 1.02))
        ep = bpy.context.active_object
        ep.name = f"WingEnd_{'L' if y > 0 else 'R'}"
        ep.scale = (0.32, 0.028, 0.18)
        ep.rotation_euler[1] = math.radians(10)
        apply_object(ep)
        ep.data.materials.append(black)
        shade_flat(ep)
    return w


def add_lights(led_w, led_r):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(2.12, 0, 0.30))
    bar = bpy.context.active_object
    bar.name = "FrontLED"
    bar.scale = (0.025, 0.92, 0.018)
    apply_object(bar)
    bar.data.materials.append(led_w)
    for y in (-0.88, 0.88):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(2.05, y, 0.29))
        h = bpy.context.active_object
        h.name = f"FrontCorner_{y}"
        h.scale = (0.035, 0.07, 0.03)
        apply_object(h)
        h.data.materials.append(led_w)

    bpy.ops.mesh.primitive_cube_add(size=1, location=(-2.08, 0, 0.44))
    rb = bpy.context.active_object
    rb.name = "RearLED"
    rb.scale = (0.02, 0.92, 0.016)
    apply_object(rb)
    rb.data.materials.append(led_r)


def add_wheel(name, x, y, tire_mat, spoke_mat, disc_mat):
    """Wheel hub at (x,y,z=0.32). Axle along Y (Blender) → Z in glTF."""
    hub = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(hub)
    hub.empty_display_type = "SPHERE"
    hub.empty_display_size = 0.05
    hub.location = (x, y, 0.32)

    def make_axle_cylinder(radius, depth, verts=24):
        # Bake rotation into mesh so export can't flatten tires into pancakes
        bpy.ops.mesh.primitive_cylinder_add(
            radius=radius,
            depth=depth,
            location=(x, y, 0.32),
            rotation=(math.pi / 2, 0, 0),
            vertices=verts,
        )
        ob = bpy.context.active_object
        apply_object(ob)
        ob.parent = hub
        ob.location = (0.0, 0.0, 0.0)
        ob.rotation_euler = (0.0, 0.0, 0.0)
        return ob

    tire = make_axle_cylinder(0.32, 0.22, 24)
    tire.name = name + "_Tire"
    tire.data.materials.append(tire_mat)
    shade_smooth(tire)

    side = make_axle_cylinder(0.23, 0.12, 20)
    side.name = name + "_Sidewall"
    side.data.materials.append(tire_mat)
    shade_smooth(side)

    disc = make_axle_cylinder(0.20, 0.04, 20)
    disc.name = name + "_Disc"
    disc.data.materials.append(disc_mat)
    shade_flat(disc)

    for i in range(6):
        ang = i * math.pi / 3
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, 0.32))
        sp = bpy.context.active_object
        sp.name = name + f"_Spoke{i}"
        sp.scale = (0.03, 0.045, 0.14)
        apply_object(sp)
        sp.rotation_euler = (0, ang, 0)
        apply_object(sp)
        sp.data.materials.append(spoke_mat)
        shade_flat(sp)
        sp.parent = hub
        sp.location = (math.sin(ang) * 0.01, 0.0, math.cos(ang) * 0.01)
        sp.rotation_euler = (0.0, 0.0, 0.0)

    cap = make_axle_cylinder(0.05, 0.055, 16)
    cap.name = name + "_Cap"
    cap.data.materials.append(spoke_mat)
    shade_flat(cap)
    return hub


def add_badge_and_plate(black, plate_mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(2.06, 0, 0.46))
    stem = bpy.context.active_object
    stem.name = "BadgeStem"
    stem.scale = (0.015, 0.012, 0.06)
    apply_object(stem)
    stem.data.materials.append(black)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(2.06, 0, 0.51))
    bar = bpy.context.active_object
    bar.name = "BadgeBar"
    bar.scale = (0.015, 0.07, 0.012)
    apply_object(bar)
    bar.data.materials.append(black)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-2.12, 0, 0.28))
    pl = bpy.context.active_object
    pl.name = "PlateBack"
    pl.scale = (0.015, 0.15, 0.055)
    apply_object(pl)
    pl.data.materials.append(black)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-2.14, 0, 0.28))
    pf = bpy.context.active_object
    pf.name = "PlateFace"
    pf.scale = (0.004, 0.13, 0.045)
    apply_object(pf)
    pf.data.materials.append(plate_mat)


def add_thruster_empties():
    bay = bpy.data.objects.new("ThrusterBay", None)
    bpy.context.collection.objects.link(bay)
    bay.empty_display_type = "CUBE"
    bay.empty_display_size = 0.15
    bay.location = (-1.95, 0, 0.12)
    for i, y in enumerate([-0.48, -0.16, 0.16, 0.48]):
        e = bpy.data.objects.new(f"BrassPort_{i}", None)
        bpy.context.collection.objects.link(e)
        e.empty_display_type = "CIRCLE"
        e.empty_display_size = 0.05
        e.location = (-2.05, y, 0.14)
        e.parent = bay
    for i, (x, y) in enumerate([(0.02, -0.72), (0.0, -0.42), (0.0, 0.42), (0.02, 0.72)]):
        e = bpy.data.objects.new(f"Nozzle_{i}", None)
        bpy.context.collection.objects.link(e)
        e.empty_display_type = "SINGLE_ARROW"
        e.empty_display_size = 0.08
        e.location = (-1.95 + x, y, 0.05)
        e.rotation_euler = (math.pi, 0, 0)  # point −Z (down)
        e.parent = bay
    return bay


def add_brass_ports_mesh(brass, fill):
    for i, y in enumerate([-0.48, -0.16, 0.16, 0.48]):
        bpy.ops.mesh.primitive_torus_add(
            major_radius=0.055,
            minor_radius=0.012,
            location=(-2.08, y, 0.14),
            rotation=(0, math.pi / 2, 0),
        )
        t = bpy.context.active_object
        t.name = f"BrassRing_{i}"
        t.data.materials.append(brass)
        shade_smooth(t)
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.045, depth=0.02, location=(-2.07, y, 0.14), rotation=(0, math.pi / 2, 0)
        )
        c = bpy.context.active_object
        c.name = f"PortFill_{i}"
        c.data.materials.append(fill)


def render_previews(out_dir):
    """Quick EEVEE stills while the car is correctly Z-up in Blender."""
    os.makedirs(out_dir, exist_ok=True)
    coords = []
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        for corner in ob.bound_box:
            coords.append(ob.matrix_world @ Vector(corner))
    if not coords:
        return
    center = sum(coords, Vector()) / len(coords)
    min_z = min(c.z for c in coords)

    bpy.ops.mesh.primitive_plane_add(size=14, location=(center.x, center.y, min_z))
    gnd = bpy.context.active_object
    gnd.name = "_PreviewGround"
    gmat = bpy.data.materials.new("PreviewGround")
    gmat.use_nodes = True
    gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.22, 0.23, 0.25, 1)
    gmat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.95
    gnd.data.materials.append(gmat)

    bpy.ops.object.light_add(type="SUN", location=(5, -4, 8))
    sun = bpy.context.active_object
    sun.name = "_PreviewSun"
    sun.data.energy = 3.0
    sun.rotation_euler = (0.7, 0.2, 0.4)
    bpy.ops.object.light_add(type="AREA", location=(-3, 3, 5))
    area = bpy.context.active_object
    area.name = "_PreviewArea"
    area.data.energy = 280
    area.data.size = 6

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    world = bpy.data.worlds.new("PreviewWorld")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.58, 0.62, 1)

    shots = {
        "blender_car_front_3q": Vector((center.x + 4.2, center.y - 3.2, center.z + 1.5)),
        "blender_car_side": Vector((center.x + 0.2, center.y - 5.5, center.z + 1.1)),
        "blender_car_rear": Vector((center.x - 4.5, center.y - 2.8, center.z + 1.4)),
    }
    for name, loc in shots.items():
        cam_data = bpy.data.cameras.new(name)
        cam = bpy.data.objects.new(name, cam_data)
        scene.collection.objects.link(cam)
        cam.location = loc
        cam.rotation_euler = (center + Vector((0, 0, 0.15)) - loc).to_track_quat("-Z", "Y").to_euler()
        scene.camera = cam
        scene.render.filepath = os.path.join(out_dir, name + ".png")
        bpy.ops.render.render(write_still=True)
        print("preview", name)

    # Remove preview helpers so they aren't exported
    for n in ["_PreviewGround", "_PreviewSun", "_PreviewArea"] + list(shots.keys()):
        ob = bpy.data.objects.get(n)
        if ob:
            bpy.data.objects.remove(ob, do_unlink=True)


def export_glb(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = bpy.data.objects.get("BodyShell")
    if not body or body.type != "MESH" or len(body.data.polygons) < 10:
        raise SystemExit("BodyShell missing or empty — abort export")

    coords = []
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        for corner in ob.bound_box:
            coords.append(ob.matrix_world @ Vector(corner))
    if coords:
        min_z = min(c.z for c in coords)
        root = bpy.data.objects.get("tesla-roadster-2026")
        if root:
            root.location.z -= min_z

    print("exporting meshes:", sorted(o.name for o in bpy.data.objects if o.type == "MESH"))
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
    )
    size = os.path.getsize(path)
    print(f"Exported {path} ({size} bytes, {size/1024:.1f} KB)")
    if size > 1024 * 1024:
        raise SystemExit(f"GLB too large: {size}")


def main():
    clear_scene()
    paint = make_mat("Paint", (0.90, 0.91, 0.93), metal=0.45, rough=0.32)
    black = make_mat("BlackCladding", (0.035, 0.038, 0.042), metal=0.2, rough=0.62)
    # Fully opaque dark canopy — flush look, no see-through gaps
    glass = make_mat("Glass", (0.04, 0.05, 0.07), metal=0.25, rough=0.08, alpha=1.0)
    led_w = make_mat(
        "LEDWhite", (0.95, 0.97, 1.0), metal=0.2, rough=0.25, emission=((0.85, 0.9, 1.0), 5.0)
    )
    led_r = make_mat(
        "LEDRed", (1.0, 0.08, 0.1), metal=0.2, rough=0.3, emission=((1.0, 0.1, 0.12), 6.0)
    )
    brass = make_mat("Brass", (0.77, 0.64, 0.35), metal=0.95, rough=0.28)
    fill = make_mat("PortFill", (0.03, 0.03, 0.035), metal=0.3, rough=0.8)
    tire = make_mat("Tire", (0.04, 0.04, 0.05), metal=0.02, rough=0.94)
    spoke = make_mat("Spoke", (0.08, 0.09, 0.10), metal=0.75, rough=0.32)
    disc = make_mat("AeroDisc", (0.82, 0.84, 0.88), metal=0.25, rough=0.38)
    plate = make_mat("Plate", (0.85, 0.87, 0.9), metal=0.1, rough=0.6)

    body = build_body_shell(paint, black)
    add_lower_cladding(black)
    add_canopy(glass)
    add_wing(paint, black)
    add_lights(led_w, led_r)
    add_badge_and_plate(black, plate)
    add_brass_ports_mesh(brass, fill)
    add_thruster_empties()

    for name, x, y in [
        ("Wheel_Ft_L", 1.28, 0.90),
        ("Wheel_Ft_R", 1.28, -0.90),
        ("Wheel_Bk_L", -1.32, 0.90),
        ("Wheel_Bk_R", -1.32, -0.90),
    ]:
        add_wheel(name, x, y, tire, spoke, disc)

    root = bpy.data.objects.new("tesla-roadster-2026", None)
    bpy.context.collection.objects.link(root)
    for ob in list(bpy.context.scene.objects):
        if ob != root and ob.parent is None:
            ob.parent = root

    assert bpy.data.objects.get("BodyShell")
    assert bpy.data.objects.get("Canopy")
    assert bpy.data.objects.get("RearWing")
    assert bpy.data.objects.get("Wheel_Ft_L")

    render_previews("/opt/cursor/artifacts")
    export_glb(OUT)
    print("OK")


if __name__ == "__main__":
    main()
