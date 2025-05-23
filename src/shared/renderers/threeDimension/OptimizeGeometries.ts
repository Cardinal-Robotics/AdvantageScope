import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getSpiralIndex } from "../../util";
import { disposeObject } from "../ThreeDimensionRendererImpl";

export const XR_MAX_RADIUS = 0.08;
export const LOW_POWER_MAX_RADIUS = 0.08;
export const STANDARD_MAX_RADIUS = 0.04;
export const CINEMATIC_MAX_RADIUS = 0.02;

export default async function optimizeGeometries(
  object: THREE.Object3D,
  mode: "low-power" | "standard" | "cinematic",
  materialSpecular: THREE.Color,
  materialShininess: number,
  enableSimplification = true,
  slicingSize?: number
): Promise<{
  normal: THREE.Mesh[];
  transparent: THREE.Mesh[];
  carpet: THREE.Mesh[];
}> {
  return new Promise(async (resolve) => {
    let geometries = getGeometries(object, mode, enableSimplification, slicingSize);

    let normalMeshes: THREE.Mesh[] = [];
    let transparentMeshes: THREE.Mesh[] = [];
    let carpetMeshes: THREE.Mesh[] = [];
    for (const group of geometries.normal) {
      if (group.length < 0) continue;
      let geometry = BufferGeometryUtils.mergeGeometries(group, false);
      if (geometry !== null) {
        let mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshPhongMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            specular: materialSpecular,
            shininess: materialShininess
          })
        );
        normalMeshes.push(mesh);
        if (mode === "cinematic") {
          mesh.castShadow = true;
          mesh.receiveShadow = false;
        }
        mesh.name = "normal";
      }
    }

    for (const group of geometries.transparent) {
      if (group.length < 0) continue;
      let geometry = BufferGeometryUtils.mergeGeometries(group, false);
      if (geometry !== null) {
        let mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshPhongMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            specular: materialSpecular,
            shininess: materialShininess,
            transparent: true,
            opacity: 0.2
          })
        );
        transparentMeshes.push(mesh);
        if (mode === "cinematic") {
          mesh.castShadow = true;
          mesh.receiveShadow = false;
        }
        mesh.name = "transparent";
      }
    }

    for (const group of geometries.carpet) {
      if (group.length < 0) continue;
      let geometry = BufferGeometryUtils.mergeGeometries(group, false);
      if (geometry !== null) {
        let mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshPhongMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            specular: materialSpecular,
            shininess: 0
          })
        );
        carpetMeshes.push(mesh);
        if (mode === "cinematic") {
          mesh.castShadow = false;
          mesh.receiveShadow = true;
        }
        mesh.name = "carpet";
      }
    }

    disposeObject(object);
    resolve({
      normal: normalMeshes,
      transparent: transparentMeshes,
      carpet: carpetMeshes
    });
  });
}

function getGeometries(
  object: THREE.Object3D,
  mode: "low-power" | "standard" | "cinematic",
  enableSimplification: boolean,
  slicingSize?: number
): { normal: THREE.BufferGeometry[][]; transparent: THREE.BufferGeometry[][]; carpet: THREE.BufferGeometry[][] } {
  let normal: THREE.BufferGeometry[][] = [];
  let transparent: THREE.BufferGeometry[][] = [];
  let carpet: THREE.BufferGeometry[][] = [];

  // Runs function on object and all of it's descendents (ex. children of children of children...)
  const objects = [object];
  // currently stuck, for some reason the children array is empty maybe?
  while (objects.length > 0) {
    const current = objects.pop();
    if (current?.children && current.children.length > 0) {
      for (const child of current.children) objects.push(child);
    }

    processGeometryObject(object);
  }

  function processGeometryObject(object: THREE.Object3D) {
    if (object.type !== "Mesh") return;
    let mesh = object as THREE.Mesh;
    let geometry = mesh.geometry.clone();
    mesh.updateWorldMatrix(true, false);
    geometry.applyMatrix4(mesh.matrixWorld);

    // Remove unused attributes (interferes with merge)
    let attributeNames = Object.keys(geometry.attributes);
    if (!attributeNames.includes("normal") || !attributeNames.includes("position")) {
      // Doesn't include required attributes, remove
      return;
    }
    attributeNames.forEach((name) => {
      if (name !== "normal" && name !== "position") {
        geometry.deleteAttribute(name);
      }
    });

    // Apply color from material as attribute
    let isTransparent = false;
    if (!Array.isArray(mesh.material)) {
      isTransparent = mesh.material.transparent && mesh.material.opacity < 0.75;
      if ("color" in mesh.material) {
        let rgb = (mesh.material.color as THREE.Color).toArray().map((v) => v * 255);

        const numVerts = geometry.getAttribute("position").count;
        const itemSize = 3; // r, g, b
        const colors = new Uint8Array(itemSize * numVerts);

        colors.forEach((_, ndx) => {
          colors[ndx] = rgb[ndx % 3];
        });

        const normalized = true;
        const colorAttrib = new THREE.BufferAttribute(colors, itemSize, normalized);
        geometry.setAttribute("color", colorAttrib);
      }
    }

    // Apply simplification
    let include = true;
    let vertices: THREE.Vector3[] = [];
    let center = new THREE.Vector3();
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      let vertex = new THREE.Vector3(
        geometry.attributes.position.getX(i),
        geometry.attributes.position.getY(i),
        geometry.attributes.position.getZ(i)
      );
      vertices.push(vertex);
      center.add(vertex);
    }
    center.divideScalar(vertices.length);
    let maxRadius = vertices.reduce((prev, vertex) => {
      let dist = vertex.distanceTo(center);
      return dist > prev ? dist : prev;
    }, 0);
    if (enableSimplification && !mesh.name.includes("NOSIMPLIFY")) {
      switch (mode) {
        case "low-power":
          if (maxRadius < LOW_POWER_MAX_RADIUS) include = false;
          break;
        case "standard":
          if (maxRadius < STANDARD_MAX_RADIUS) include = false;
          break;
        case "cinematic":
          if (maxRadius < CINEMATIC_MAX_RADIUS) include = false;
          break;
      }
    }

    // Save final geometry
    if (include) {
      let outputIndex = 0;
      if (slicingSize !== undefined && maxRadius * 2 < slicingSize) {
        outputIndex = 1 + getSpiralIndex(Math.floor(center.x / slicingSize), Math.floor(center.y / slicingSize));
      }
      if (mesh.name.toLowerCase().includes("carpet")) {
        while (carpet.length < outputIndex + 1) {
          carpet.push([]);
        }
        carpet[outputIndex].push(geometry);
      } else if (isTransparent) {
        while (transparent.length < outputIndex + 1) {
          transparent.push([]);
        }
        transparent[outputIndex].push(geometry);
      } else {
        while (normal.length < outputIndex + 1) {
          normal.push([]);
        }
        normal[outputIndex].push(geometry);
      }
    }
  }

  return {
    normal,
    transparent,
    carpet
  };
}
