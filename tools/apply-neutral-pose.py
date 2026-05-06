"""
Paste the contents into Blender's Text Editor and click Run Script (Alt+P).
Applies the canonical "neutral idle" pose to all matching mixamorig:* bones at
the current frame of the active armature, then keyframes them.

Use this at frame 0 of every new animation to keep the starting stance consistent.
"""

import bpy
POSE = {
    "mixamorig:Head": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:HeadTop_End": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:Hips": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftArm": {"loc": (0.000359, 0.00934, -8.3e-05), "rot": (0.780115, 0.617749, 0.022129, -0.096528), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftFoot": {"loc": (-0.0, -0.0, -0.0), "rot": (0.995012, 0.09939, 0.002968, 0.008026), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftForeArm": {"loc": (-0.0, 0.0, 0.0), "rot": (0.982315, 0.057369, 0.020689, 0.177027), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHand": {"loc": (0.0, 0.0, -0.0), "rot": (0.997083, 0.069688, -0.0117, 0.028857), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandIndex1": {"loc": (-0.0, 0.0, 0.0), "rot": (1.0, -0.0, -0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandIndex2": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandIndex3": {"loc": (0.0, -0.0, 0.0), "rot": (1.0, 0.0, -0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandIndex4": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, -0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandMiddle1": {"loc": (-0.0, -0.0, 0.0), "rot": (1.0, -0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandMiddle2": {"loc": (-0.0, 0.0, -0.0), "rot": (1.0, -0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandMiddle3": {"loc": (0.0, 0.0, -0.0), "rot": (1.0, -0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandMiddle4": {"loc": (-0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandPinky1": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandPinky2": {"loc": (-0.0, -0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandPinky3": {"loc": (-0.0, 0.0, -0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandPinky4": {"loc": (-0.0, 0.0, -0.0), "rot": (1.0, 0.0, -0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandRing1": {"loc": (-0.0, 0.0, 0.0), "rot": (1.0, -0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandRing2": {"loc": (-0.0, -0.0, -0.0), "rot": (1.0, -0.0, -0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandRing3": {"loc": (-0.0, 0.0, -0.0), "rot": (1.0, -0.0, -0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftHandRing4": {"loc": (-0.0, -0.0, -0.0), "rot": (1.0, -0.0, -0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftLeg": {"loc": (0.0, -0.0, -0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftShoulder": {"loc": (-0.0, -0.0, -0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftToeBase": {"loc": (0.0, 0.0, -0.0), "rot": (1.0, 0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftToe_End": {"loc": (-0.0, 0.0, -0.0), "rot": (1.0, 0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:LeftUpLeg": {"loc": (-0.0, 0.0, 0.0), "rot": (0.993768, -0.093616, -0.058815, 0.014208), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:Neck": {"loc": (-0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightArm": {"loc": (-0.00064, 0.018677, -0.00052), "rot": (0.791157, 0.603343, -0.005663, 0.100079), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightFoot": {"loc": (-0.0, 0.0, 0.0), "rot": (1.0, -0.0, -0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightForeArm": {"loc": (-0.0, -0.0, -0.0), "rot": (0.982257, 0.036457, 0.013599, -0.183456), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHand": {"loc": (0.0, -0.0, -0.0), "rot": (0.997015, 0.075019, 0.011854, 0.013859), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandIndex1": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, -0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandIndex2": {"loc": (0.0, -0.0, -0.0), "rot": (1.0, 0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandIndex3": {"loc": (-0.0, -0.0, -0.0), "rot": (1.0, 0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandIndex4": {"loc": (-0.0, 0.0, -0.0), "rot": (1.0, -0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandMiddle1": {"loc": (0.0, 0.0, -0.0), "rot": (1.0, 0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandMiddle2": {"loc": (-0.0, 0.0, 0.0), "rot": (1.0, -0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandMiddle3": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, -0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandMiddle4": {"loc": (0.0, -0.0, -0.0), "rot": (1.0, -0.0, -0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandPinky1": {"loc": (0.0, 0.0, -0.0), "rot": (1.0, 0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandPinky2": {"loc": (-0.0, 0.0, 0.0), "rot": (1.0, 0.0, -0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandPinky3": {"loc": (0.0, -0.0, -0.0), "rot": (1.0, 0.0, -0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandPinky4": {"loc": (-0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandRing1": {"loc": (0.0, 0.0, -0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandRing2": {"loc": (0.0, -0.0, -0.0), "rot": (1.0, -0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandRing3": {"loc": (0.0, -0.0, 0.0), "rot": (1.0, -0.0, -0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightHandRing4": {"loc": (0.0, -0.0, -0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightLeg": {"loc": (0.0, -0.0, -0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightShoulder": {"loc": (-0.0, -0.0, 0.0), "rot": (1.0, 0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightToeBase": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightToe_End": {"loc": (0.0, -0.0, -0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:RightUpLeg": {"loc": (-0.0, 0.0, -0.0), "rot": (0.996254, 0.040667, 0.07366, -0.01996), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:Spine": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, 0.0, 0.0, 0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:Spine1": {"loc": (0.0, 0.0, -0.0), "rot": (1.0, 0.0, -0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
    "mixamorig:Spine2": {"loc": (0.0, 0.0, 0.0), "rot": (1.0, -0.0, 0.0, -0.0), "scl": (1.0, 1.0, 1.0)},
}


arm = bpy.context.active_object
if not arm or arm.type != "ARMATURE":
    raise RuntimeError("Active object must be an armature")

# Apply pose values + insert keyframes at the current frame
applied = 0
frame = bpy.context.scene.frame_current
for bone_name, vals in POSE.items():
    pb = arm.pose.bones.get(bone_name)
    if not pb:
        continue
    pb.location = vals["loc"]
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = vals["rot"]
    pb.scale = vals["scl"]
    pb.keyframe_insert("location", frame=frame)
    pb.keyframe_insert("rotation_quaternion", frame=frame)
    pb.keyframe_insert("scale", frame=frame)
    applied += 1

print(f"Applied neutral pose to {applied}/{len(POSE)} bones at frame {frame}")
