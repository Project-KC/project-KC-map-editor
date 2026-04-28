"""
Batch convert Polytope Studio FBX armor to GLB, rebinding to the game character's
Mixamo skeleton so armor deforms with character animations at runtime.

Run with: blender --background --python tools/convert-polytope-fbx.py

How it works:
1. Import the game character GLB to get the Mixamo armature
2. For each armor FBX: import, rename vertex groups PT_→mixamorig:,
   merge unmapped bone weights to nearest parent, parent to Mixamo armature,
   assign palette texture, export GLB with skinning intact.
"""
import bpy
import os
import glob

SRC_BASE = "/home/nick/My project/Assets/Polytope Studio"
DST_BASE = "/home/nick/projectnova-master/client/public/assets/equipment/polytope"
CHAR_GLB = "/home/nick/projectnova-master/client/public/Character models/main character.glb"

ARMOR_TEX = f"{SRC_BASE}/Lowpoly_Characters/Sources/Modular_Armors/Textures/PT_texture.tga"
WEAPON_TEX = f"{SRC_BASE}/Lowpoly_Weapons/Sources/Textures/PT_texture.tga"

PT_TO_MIXAMO = {
    'PT_Hips': 'mixamorig:Hips',
    'PT_Spine': 'mixamorig:Spine',
    'PT_Spine2': 'mixamorig:Spine1',
    'PT_Spine3': 'mixamorig:Spine2',
    'PT_Neck': 'mixamorig:Neck',
    'PT_Head': 'mixamorig:Head',
    'PT_LeftShoulder': 'mixamorig:LeftShoulder',
    'PT_LeftArm': 'mixamorig:LeftArm',
    'PT_LeftForeArm': 'mixamorig:LeftForeArm',
    'PT_LeftHand': 'mixamorig:LeftHand',
    'PT_LeftHandIndex1': 'mixamorig:LeftHandIndex1',
    'PT_LeftHandIndex2': 'mixamorig:LeftHandIndex2',
    'PT_LeftHandIndex3': 'mixamorig:LeftHandIndex3',
    'PT_LeftUpLeg': 'mixamorig:LeftUpLeg',
    'PT_LeftLeg': 'mixamorig:LeftLeg',
    'PT_LeftFoot': 'mixamorig:LeftFoot',
    'PT_LeftToe': 'mixamorig:LeftToeBase',
    'PT_RightShoulder': 'mixamorig:RightShoulder',
    'PT_RightArm': 'mixamorig:RightArm',
    'PT_RightForeArm': 'mixamorig:RightForeArm',
    'PT_RightHand': 'mixamorig:RightHand',
    'PT_RightHandIndex1': 'mixamorig:RightHandIndex1',
    'PT_RightHandIndex2': 'mixamorig:RightHandIndex2',
    'PT_RightHandIndex3': 'mixamorig:RightHandIndex3',
    'PT_RightUpLeg': 'mixamorig:RightUpLeg',
    'PT_RightLeg': 'mixamorig:RightLeg',
    'PT_RightFoot': 'mixamorig:RightFoot',
    'PT_RightToe': 'mixamorig:RightToeBase',
}

# Unmapped PT_ bones → nearest mapped parent bone to merge weights into.
# Cape/cloth dangle chains, arm twist, extra finger types, head feathers.
PT_MERGE_TARGET = {
    'PT_HeadTop': 'PT_Head',
    'PT_HeadTopFeathers': 'PT_Head',
    'PT_LeftArmTwist': 'PT_LeftArm',
    'PT_RightArmTwist': 'PT_RightArm',
    # Extra finger types → Hand
    'PT_LeftHandMiddle1': 'PT_LeftHand',
    'PT_LeftHandMiddle2': 'PT_LeftHand',
    'PT_LeftHandMiddle3': 'PT_LeftHand',
    'PT_LeftHandPinky1': 'PT_LeftHand',
    'PT_LeftHandPinky2': 'PT_LeftHand',
    'PT_LeftHandPinky3': 'PT_LeftHand',
    'PT_LeftHandRing1': 'PT_LeftHand',
    'PT_LeftHandRing2': 'PT_LeftHand',
    'PT_LeftHandRing3': 'PT_LeftHand',
    'PT_LeftHandThumb1': 'PT_LeftHand',
    'PT_LeftHandThumb2': 'PT_LeftHand',
    'PT_LeftHandThumb3': 'PT_LeftHand',
    'PT_RightHandMiddle1': 'PT_RightHand',
    'PT_RightHandMiddle2': 'PT_RightHand',
    'PT_RightHandMiddle3': 'PT_RightHand',
    'PT_RightHandPinky1': 'PT_RightHand',
    'PT_RightHandPinky2': 'PT_RightHand',
    'PT_RightHandPinky3': 'PT_RightHand',
    'PT_RightHandRing1': 'PT_RightHand',
    'PT_RightHandRing2': 'PT_RightHand',
    'PT_RightHandRing3': 'PT_RightHand',
    'PT_RightHandThumb1': 'PT_RightHand',
    'PT_RightHandThumb2': 'PT_RightHand',
    'PT_RightHandThumb3': 'PT_RightHand',
    # Cape chains → Spine2 (mapped as mixamorig:Spine2)
    'PT_LeftCape': 'PT_Spine3',
    'PT_LeftCape2': 'PT_Spine3',
    'PT_LeftCape3': 'PT_Spine3',
    'PT_LeftCape4': 'PT_Spine3',
    'PT_LeftCape5': 'PT_Spine3',
    'PT_RightCape': 'PT_Spine3',
    'PT_RightCape2': 'PT_Spine3',
    'PT_RightCape3': 'PT_Spine3',
    'PT_RightCape4': 'PT_Spine3',
    'PT_RightCape5': 'PT_Spine3',
    # Cloth dangle chains → parent leg bone
    'PT_Left_BackCloth': 'PT_LeftUpLeg',
    'PT_Left_BackCloth2': 'PT_LeftUpLeg',
    'PT_Left_BackCloth3': 'PT_LeftUpLeg',
    'PT_Left_FrontCloth': 'PT_LeftUpLeg',
    'PT_Left_FrontCloth2': 'PT_LeftUpLeg',
    'PT_Left_FrontCloth3': 'PT_LeftUpLeg',
    'PT_Right_BackCloth': 'PT_RightUpLeg',
    'PT_Right_BackCloth2': 'PT_RightUpLeg',
    'PT_Right_BackCloth3': 'PT_RightUpLeg',
    'PT_Right_FrontCloth': 'PT_RightUpLeg',
    'PT_Right_FrontCloth2': 'PT_RightUpLeg',
    'PT_Right_FrontCloth3': 'PT_RightUpLeg',
    # LeftHandIndex4 / RightHandIndex4 (character has them, Polytope doesn't use them but just in case)
    'PT_LeftHandIndex4': 'PT_LeftHandIndex3',
    'PT_RightHandIndex4': 'PT_RightHandIndex3',
    # LeftToe_End / RightToe_End mapped to foot
    'PT_LeftToe_End': 'PT_LeftFoot',
    'PT_RightToe_End': 'PT_RightFoot',
}

ARMOR_CONVERSIONS = [
    (f"{SRC_BASE}/Lowpoly_Characters/Sources/Modular_Armors/Meshes/Separate_Parts/*Male*_body.fbx", f"{DST_BASE}/armor_male/body", ARMOR_TEX),
    (f"{SRC_BASE}/Lowpoly_Characters/Sources/Modular_Armors/Meshes/Separate_Parts/*Male*_boots.fbx", f"{DST_BASE}/armor_male/boots", ARMOR_TEX),
    (f"{SRC_BASE}/Lowpoly_Characters/Sources/Modular_Armors/Meshes/Separate_Parts/*Male*_cape.fbx", f"{DST_BASE}/armor_male/cape", ARMOR_TEX),
    (f"{SRC_BASE}/Lowpoly_Characters/Sources/Modular_Armors/Meshes/Separate_Parts/*Male*_gauntlets.fbx", f"{DST_BASE}/armor_male/gauntlets", ARMOR_TEX),
    (f"{SRC_BASE}/Lowpoly_Characters/Sources/Modular_Armors/Meshes/Separate_Parts/*Male*_helmet.fbx", f"{DST_BASE}/armor_male/helmet", ARMOR_TEX),
    (f"{SRC_BASE}/Lowpoly_Characters/Sources/Modular_Armors/Meshes/Separate_Parts/*Male*_legs.fbx", f"{DST_BASE}/armor_male/legs", ARMOR_TEX),
]

WEAPON_CONVERSIONS = [
    (f"{SRC_BASE}/Lowpoly_Weapons/Sources/Meshes/*.fbx", f"{DST_BASE}/weapons", WEAPON_TEX),
]

converted = 0
failed = 0


def resolve_merge_target(pt_name):
    """Walk PT_MERGE_TARGET until we hit a bone that's in PT_TO_MIXAMO."""
    visited = set()
    current = pt_name
    while current not in PT_TO_MIXAMO:
        if current in PT_MERGE_TARGET:
            target = PT_MERGE_TARGET[current]
            if target in visited:
                return None
            visited.add(current)
            current = target
        else:
            return None
    return current


def merge_and_rename_vertex_groups(obj):
    """Merge unmapped PT_ vertex groups into mapped parents, then rename PT_→mixamorig:."""
    if not obj.vertex_groups:
        return

    # First pass: merge unmapped groups into their target
    groups_to_remove = []
    for vg in list(obj.vertex_groups):
        if vg.name in PT_TO_MIXAMO:
            continue
        merge_pt = resolve_merge_target(vg.name)
        if merge_pt is None:
            groups_to_remove.append(vg.name)
            continue

        target_vg = obj.vertex_groups.get(merge_pt)
        if target_vg is None:
            target_vg = obj.vertex_groups.new(name=merge_pt)

        # Add weights from source to target
        src_idx = vg.index
        for vert in obj.data.vertices:
            for g in vert.groups:
                if g.group == src_idx and g.weight > 0:
                    target_vg.add([vert.index], g.weight, 'ADD')

        groups_to_remove.append(vg.name)

    # Remove merged/unmapped groups
    for name in groups_to_remove:
        vg = obj.vertex_groups.get(name)
        if vg:
            obj.vertex_groups.remove(vg)

    # Second pass: rename PT_→mixamorig:
    for vg in obj.vertex_groups:
        if vg.name in PT_TO_MIXAMO:
            vg.name = PT_TO_MIXAMO[vg.name]


def assign_texture(tex_path):
    """Assign the palette texture to all materials in the scene."""
    img = bpy.data.images.load(tex_path)
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            mat.use_nodes = True
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links

        principled = None
        for node in nodes:
            if node.type == 'BSDF_PRINCIPLED':
                principled = node
                break
        if not principled:
            principled = nodes.new('ShaderNodeBsdfPrincipled')
            output = None
            for node in nodes:
                if node.type == 'OUTPUT_MATERIAL':
                    output = node
                    break
            if not output:
                output = nodes.new('ShaderNodeOutputMaterial')
            links.new(principled.outputs['BSDF'], output.inputs['Surface'])

        tex_node = nodes.new('ShaderNodeTexImage')
        tex_node.image = img
        tex_node.interpolation = 'Closest'
        links.new(tex_node.outputs['Color'], principled.inputs['Base Color'])

        principled.inputs['Metallic'].default_value = 0.0
        principled.inputs['Roughness'].default_value = 0.8
        principled.inputs['Specular IOR Level'].default_value = 0.0


def load_character_armature():
    """Import character GLB, return armature object. Deletes character meshes."""
    bpy.ops.import_scene.gltf(filepath=CHAR_GLB)

    char_armature = None
    char_meshes = []
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            char_armature = obj
        elif obj.type == 'MESH':
            char_meshes.append(obj)

    # Delete character meshes — we only need the skeleton
    for mesh in char_meshes:
        bpy.data.objects.remove(mesh, do_unlink=True)

    if char_armature:
        # Clear any transforms on the armature so armor isn't offset
        char_armature.location = (0, 0, 0)
        char_armature.rotation_euler = (0, 0, 0)
        char_armature.rotation_quaternion = (1, 0, 0, 0)
        char_armature.scale = (1, 1, 1)
        print(f"  Character armature loaded: {len(char_armature.data.bones)} bones")

    return char_armature


def convert_armor(fbx_path, dest_dir, tex_path, char_armature):
    """Import one armor FBX, rebind to character armature, export GLB."""
    name = os.path.splitext(os.path.basename(fbx_path))[0]
    glb_path = os.path.join(dest_dir, f"{name}.glb")

    # Import the armor FBX
    bpy.ops.import_scene.fbx(filepath=fbx_path)

    # Find the PT_ armature and armor meshes (they're the newly imported objects)
    pt_armature = None
    armor_meshes = []
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE' and obj != char_armature:
            pt_armature = obj
        elif obj.type == 'MESH' and obj.parent != char_armature:
            # Check if it's parented to the PT armature or has PT vertex groups
            has_pt_groups = any(vg.name.startswith('PT_') for vg in obj.vertex_groups) if obj.vertex_groups else False
            if has_pt_groups or (pt_armature and obj.parent == pt_armature):
                armor_meshes.append(obj)

    if not armor_meshes:
        # Fallback: grab any mesh that isn't parented to char_armature
        for obj in bpy.data.objects:
            if obj.type == 'MESH' and obj.parent != char_armature:
                armor_meshes.append(obj)

    for mesh_obj in armor_meshes:
        # Merge unmapped vertex groups and rename PT_→mixamorig:
        merge_and_rename_vertex_groups(mesh_obj)

        # Remove old armature modifier
        for mod in list(mesh_obj.modifiers):
            if mod.type == 'ARMATURE':
                mesh_obj.modifiers.remove(mod)

        # Unparent while keeping world transforms (preserves the FBX 0.01 cm→m scale),
        # then bake those transforms into vertex data so vertices are in meter space.
        world_mat = mesh_obj.matrix_world.copy()
        mesh_obj.parent = None
        mesh_obj.matrix_world = world_mat
        bpy.context.view_layer.objects.active = mesh_obj
        mesh_obj.select_set(True)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        mesh_obj.select_set(False)

        # Parent mesh to character armature with armature deform (keep vertex groups)
        mesh_obj.parent = char_armature
        mod = mesh_obj.modifiers.new(name='Armature', type='ARMATURE')
        mod.object = char_armature

    # Delete the PT armature
    if pt_armature:
        bpy.data.objects.remove(pt_armature, do_unlink=True)

    # Assign palette texture
    assign_texture(tex_path)

    # Select only the armor meshes and the character armature for export
    bpy.ops.object.select_all(action='DESELECT')
    char_armature.select_set(True)
    for mesh_obj in armor_meshes:
        if mesh_obj.name in bpy.data.objects:
            mesh_obj.select_set(True)

    os.makedirs(dest_dir, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format='GLB',
        use_selection=True,
        export_apply=False,
        export_skins=True,
        export_animations=False,
    )

    # Clean up armor meshes and their materials for the next iteration
    for mesh_obj in armor_meshes:
        if mesh_obj.name in bpy.data.objects:
            bpy.data.objects.remove(mesh_obj, do_unlink=True)

    # Purge orphan data from this FBX import
    for block in list(bpy.data.meshes):
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        if block.users == 0:
            bpy.data.materials.remove(block)
    for block in list(bpy.data.images):
        if block.users == 0:
            bpy.data.images.remove(block)

    print(f"  OK: {name}")


def convert_weapon(fbx_path, dest_dir, tex_path):
    """Import one weapon FBX, assign texture, export as static GLB (no skeleton)."""
    name = os.path.splitext(os.path.basename(fbx_path))[0]
    glb_path = os.path.join(dest_dir, f"{name}.glb")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    assign_texture(tex_path)

    os.makedirs(dest_dir, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format='GLB',
        use_selection=False,
        export_apply=True,
    )

    print(f"  OK: {name}")


# === Weapons (static, no skeleton needed) ===
for src_glob, dest_dir, tex_path in WEAPON_CONVERSIONS:
    files = sorted(glob.glob(src_glob))
    print(f"\n=== WEAPONS: {dest_dir} ({len(files)} files) ===")
    for fbx_path in files:
        try:
            convert_weapon(fbx_path, dest_dir, tex_path)
            converted += 1
        except Exception as e:
            name = os.path.splitext(os.path.basename(fbx_path))[0]
            print(f"  FAIL: {name} — {e}")
            failed += 1

# === Armor (rebind to character skeleton) ===
# Load character armature once, reuse for all armor pieces
print("\n=== Loading character armature ===")
bpy.ops.wm.read_factory_settings(use_empty=True)
char_armature = load_character_armature()

if not char_armature:
    print("FATAL: Could not load character armature from", CHAR_GLB)
else:
    for src_glob, dest_dir, tex_path in ARMOR_CONVERSIONS:
        files = sorted(glob.glob(src_glob))
        print(f"\n=== ARMOR: {dest_dir} ({len(files)} files) ===")
        for fbx_path in files:
            try:
                convert_armor(fbx_path, dest_dir, tex_path, char_armature)
                converted += 1
            except Exception as e:
                name = os.path.splitext(os.path.basename(fbx_path))[0]
                print(f"  FAIL: {name} — {e}")
                failed += 1

print(f"\n=== Done: {converted} converted, {failed} failed ===")
