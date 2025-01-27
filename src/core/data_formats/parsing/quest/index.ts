import Logger from "js-logger";
import {
    Instruction,
    InstructionSegment,
    Segment,
    SegmentType,
} from "../../../../quest_editor/scripting/instructions";
import { Opcode } from "../../../../quest_editor/scripting/opcodes";
import { prs_compress } from "../../compression/prs/compress";
import { prs_decompress } from "../../compression/prs/decompress";
import { ArrayBufferCursor } from "../../cursor/ArrayBufferCursor";
import { Cursor } from "../../cursor/Cursor";
import { ResizableBufferCursor } from "../../cursor/ResizableBufferCursor";
import { Endianness } from "../../Endianness";
import { Vec3 } from "../../vector";
import { BinFile, parse_bin, write_bin } from "./bin";
import { DatFile, DatNpc, DatObject, DatUnknown, parse_dat, write_dat } from "./dat";
import { QuestNpc, QuestObject } from "./entities";
import { Episode } from "./Episode";
import { object_data, ObjectType, pso_id_to_object_type } from "./object_types";
import { parse_qst, QstContainedFile, write_qst } from "./qst";
import { NpcType } from "./npc_types";

const logger = Logger.get("data_formats/parsing/quest");

export type Quest = {
    readonly id: number;
    readonly language: number;
    readonly name: string;
    readonly short_description: string;
    readonly long_description: string;
    readonly episode: Episode;
    readonly objects: QuestObject[];
    readonly npcs: QuestNpc[];
    /**
     * (Partial) raw DAT data that can't be parsed yet by Phantasmal.
     */
    readonly dat_unknowns: DatUnknown[];
    readonly object_code: Segment[];
    readonly shop_items: number[];
    readonly map_designations: Map<number, number>;
};

/**
 * High level parsing function that delegates to lower level parsing functions.
 *
 * Always delegates to parse_qst at the moment.
 */
export function parse_quest(cursor: Cursor, lenient: boolean = false): Quest | undefined {
    // Extract contained .dat and .bin files.
    const qst = parse_qst(cursor);

    if (!qst) {
        return;
    }

    let dat_file: QstContainedFile | undefined;
    let bin_file: QstContainedFile | undefined;

    for (const file of qst.files) {
        const file_name = file.name.trim().toLowerCase();

        if (file_name.endsWith(".dat")) {
            dat_file = file;
        } else if (file_name.endsWith(".bin")) {
            bin_file = file;
        }
    }

    if (!dat_file) {
        logger.error("File contains no DAT file.");
        return;
    }

    if (!bin_file) {
        logger.error("File contains no BIN file.");
        return;
    }

    // Decompress and parse contained files.
    const dat_decompressed = prs_decompress(
        new ArrayBufferCursor(dat_file.data, Endianness.Little),
    );
    const dat = parse_dat(dat_decompressed);
    const objects = parse_obj_data(dat.objs);

    const bin_decompressed = prs_decompress(
        new ArrayBufferCursor(bin_file.data, Endianness.Little),
    );
    const bin = parse_bin(
        bin_decompressed,
        extract_script_entry_points(objects, dat.npcs),
        lenient,
    );

    // Extract episode and map designations from object code.
    let episode = Episode.I;
    let map_designations: Map<number, number> = new Map();

    if (bin.object_code.length) {
        let label_0_segment: InstructionSegment | undefined;

        for (const segment of bin.object_code) {
            if (segment.type === SegmentType.Instructions && segment.labels.includes(0)) {
                label_0_segment = segment;
                break;
            }
        }

        if (label_0_segment) {
            episode = get_episode(label_0_segment.instructions);
            map_designations = extract_map_designations(dat, episode, label_0_segment.instructions);
        } else {
            logger.warn(`No instruction for label 0 found.`);
        }
    } else {
        logger.warn("File contains no instruction labels.");
    }

    return {
        id: bin.quest_id,
        language: bin.language,
        name: bin.quest_name,
        short_description: bin.short_description,
        long_description: bin.long_description,
        episode,
        objects,
        npcs: parse_npc_data(episode, dat.npcs),
        dat_unknowns: dat.unknowns,
        object_code: bin.object_code,
        shop_items: bin.shop_items,
        map_designations,
    };
}

export function write_quest_qst(quest: Quest, file_name: string): ArrayBuffer {
    const dat = write_dat({
        objs: objects_to_dat_data(quest.objects),
        npcs: npcs_to_dat_data(quest.npcs),
        unknowns: quest.dat_unknowns,
    });
    const bin = write_bin(
        new BinFile(
            quest.id,
            quest.language,
            quest.name,
            quest.short_description,
            quest.long_description,
            quest.object_code,
            quest.shop_items,
        ),
    );
    const ext_start = file_name.lastIndexOf(".");
    const base_file_name =
        ext_start === -1 ? file_name.slice(0, 11) : file_name.slice(0, Math.min(11, ext_start));

    return write_qst({
        files: [
            {
                name: base_file_name + ".dat",
                id: quest.id,
                data: prs_compress(
                    new ResizableBufferCursor(dat, Endianness.Little),
                ).array_buffer(),
            },
            {
                name: base_file_name + ".bin",
                id: quest.id,
                data: prs_compress(new ArrayBufferCursor(bin, Endianness.Little)).array_buffer(),
            },
        ],
    });
}

/**
 * Defaults to episode I.
 */
function get_episode(func_0_instructions: Instruction[]): Episode {
    const set_episode = func_0_instructions.find(
        instruction => instruction.opcode === Opcode.SET_EPISODE,
    );

    if (set_episode) {
        switch (set_episode.args[0].value) {
            default:
            case 0:
                return Episode.I;
            case 1:
                return Episode.II;
            case 2:
                return Episode.IV;
        }
    } else {
        logger.debug("Function 0 has no set_episode instruction.");
        return Episode.I;
    }
}

function extract_map_designations(
    dat: DatFile,
    episode: Episode,
    func_0_instructions: Instruction[],
): Map<number, number> {
    const map_designations = new Map<number, number>();

    for (const inst of func_0_instructions) {
        if (inst.opcode === Opcode.BB_MAP_DESIGNATE) {
            map_designations.set(inst.args[0].value, inst.args[2].value);
        }
    }

    return map_designations;
}

function extract_script_entry_points(objects: QuestObject[], npcs: DatNpc[]): number[] {
    const entry_points = new Set([0]);

    for (const obj of objects) {
        const entry_point = obj.properties.get("script_label");

        if (entry_point != undefined) {
            entry_points.add(entry_point);
        }

        const entry_point_2 = obj.properties.get("script_label_2");

        if (entry_point_2 != undefined) {
            entry_points.add(entry_point_2);
        }
    }

    for (const npc of npcs) {
        entry_points.add(Math.round(npc.script_label));
    }

    return [...entry_points];
}

function parse_obj_data(objs: DatObject[]): QuestObject[] {
    return objs.map(obj_data => {
        const type = pso_id_to_object_type(obj_data.type_id);

        return {
            type,
            id: obj_data.id,
            group_id: obj_data.group_id,
            area_id: obj_data.area_id,
            section_id: obj_data.section_id,
            position: obj_data.position,
            rotation: obj_data.rotation,
            properties: new Map(
                obj_data.properties.map((value, index) => {
                    if (
                        index === 3 &&
                        (type === ObjectType.ScriptCollision ||
                            type === ObjectType.ForestConsole ||
                            type === ObjectType.TalkLinkToSupport)
                    ) {
                        return ["script_label", value];
                    } else if (index === 4 && type === ObjectType.RicoMessagePod) {
                        return ["script_label", value];
                    } else if (index === 5 && type === ObjectType.RicoMessagePod) {
                        return ["script_label_2", value];
                    } else {
                        return [`property_${index}`, value];
                    }
                }),
            ),
            unknown: obj_data.unknown,
        };
    });
}

function parse_npc_data(episode: number, npcs: DatNpc[]): QuestNpc[] {
    return npcs.map(npc_data => {
        return {
            type: get_npc_type(episode, npc_data),
            area_id: npc_data.area_id,
            section_id: npc_data.section_id,
            position: npc_data.position,
            rotation: npc_data.rotation,
            scale: npc_data.scale,
            unknown: npc_data.unknown,
            pso_type_id: npc_data.type_id,
            npc_id: npc_data.npc_id,
            script_label: Math.round(npc_data.script_label),
            roaming: npc_data.roaming,
        };
    });
}

// TODO: detect Mothmant, St. Rappy, Hallo Rappy, Egg Rappy, Death Gunner, Bulk and Recon.
function get_npc_type(episode: number, { type_id, scale, roaming, area_id }: DatNpc): NpcType {
    const regular = Math.abs(scale.y - 1) > 0.00001;

    switch (`${type_id}, ${roaming % 3}, ${episode}`) {
        case `${0x044}, 0, 1`:
            return NpcType.Booma;
        case `${0x044}, 1, 1`:
            return NpcType.Gobooma;
        case `${0x044}, 2, 1`:
            return NpcType.Gigobooma;

        case `${0x063}, 0, 1`:
            return NpcType.EvilShark;
        case `${0x063}, 1, 1`:
            return NpcType.PalShark;
        case `${0x063}, 2, 1`:
            return NpcType.GuilShark;

        case `${0x0a6}, 0, 1`:
            return NpcType.Dimenian;
        case `${0x0a6}, 0, 2`:
            return NpcType.Dimenian2;
        case `${0x0a6}, 1, 1`:
            return NpcType.LaDimenian;
        case `${0x0a6}, 1, 2`:
            return NpcType.LaDimenian2;
        case `${0x0a6}, 2, 1`:
            return NpcType.SoDimenian;
        case `${0x0a6}, 2, 2`:
            return NpcType.SoDimenian2;

        case `${0x0d6}, 0, 2`:
            return NpcType.Mericarol;
        case `${0x0d6}, 1, 2`:
            return NpcType.Mericus;
        case `${0x0d6}, 2, 2`:
            return NpcType.Merikle;

        case `${0x115}, 0, 4`:
            return NpcType.Boota;
        case `${0x115}, 1, 4`:
            return NpcType.ZeBoota;
        case `${0x115}, 2, 4`:
            return NpcType.BaBoota;
        case `${0x117}, 0, 4`:
            return NpcType.Goran;
        case `${0x117}, 1, 4`:
            return NpcType.PyroGoran;
        case `${0x117}, 2, 4`:
            return NpcType.GoranDetonator;
    }

    switch (`${type_id}, ${roaming % 2}, ${episode}`) {
        case `${0x040}, 0, 1`:
            return NpcType.Hildebear;
        case `${0x040}, 0, 2`:
            return NpcType.Hildebear2;
        case `${0x040}, 1, 1`:
            return NpcType.Hildeblue;
        case `${0x040}, 1, 2`:
            return NpcType.Hildeblue2;
        case `${0x041}, 0, 1`:
            return NpcType.RagRappy;
        case `${0x041}, 0, 2`:
            return NpcType.RagRappy2;
        case `${0x041}, 0, 4`:
            return NpcType.SandRappy;
        case `${0x041}, 1, 1`:
            return NpcType.AlRappy;
        case `${0x041}, 1, 2`:
            return NpcType.LoveRappy;
        case `${0x041}, 1, 4`:
            return NpcType.DelRappy;

        case `${0x080}, 0, 1`:
            return NpcType.Dubchic;
        case `${0x080}, 0, 2`:
            return NpcType.Dubchic2;
        case `${0x080}, 1, 1`:
            return NpcType.Gilchic;
        case `${0x080}, 1, 2`:
            return NpcType.Gilchic2;

        case `${0x0d4}, 0, 2`:
            return NpcType.SinowBerill;
        case `${0x0d4}, 1, 2`:
            return NpcType.SinowSpigell;
        case `${0x0d5}, 0, 2`:
            return NpcType.Merillia;
        case `${0x0d5}, 1, 2`:
            return NpcType.Meriltas;
        case `${0x0d7}, 0, 2`:
            return NpcType.UlGibbon;
        case `${0x0d7}, 1, 2`:
            return NpcType.ZolGibbon;

        case `${0x0dd}, 0, 2`:
            return NpcType.Dolmolm;
        case `${0x0dd}, 1, 2`:
            return NpcType.Dolmdarl;
        case `${0x0e0}, 0, 2`:
            return area_id > 15 ? NpcType.Epsilon : NpcType.SinowZoa;
        case `${0x0e0}, 1, 2`:
            return area_id > 15 ? NpcType.Epsilon : NpcType.SinowZele;

        case `${0x112}, 0, 4`:
            return NpcType.MerissaA;
        case `${0x112}, 1, 4`:
            return NpcType.MerissaAA;
        case `${0x114}, 0, 4`:
            return NpcType.Zu;
        case `${0x114}, 1, 4`:
            return NpcType.Pazuzu;
        case `${0x116}, 0, 4`:
            return NpcType.Dorphon;
        case `${0x116}, 1, 4`:
            return NpcType.DorphonEclair;
        case `${0x119}, 0, 4`:
            return regular ? NpcType.SaintMilion : NpcType.Kondrieu;
        case `${0x119}, 1, 4`:
            return regular ? NpcType.Shambertin : NpcType.Kondrieu;
    }

    switch (`${type_id}, ${episode}`) {
        case `${0x042}, 1`:
            return NpcType.Monest;
        case `${0x042}, 2`:
            return NpcType.Monest2;
        case `${0x043}, 1`:
            return regular ? NpcType.SavageWolf : NpcType.BarbarousWolf;
        case `${0x043}, 2`:
            return regular ? NpcType.SavageWolf2 : NpcType.BarbarousWolf2;

        case `${0x060}, 1`:
            return NpcType.GrassAssassin;
        case `${0x060}, 2`:
            return NpcType.GrassAssassin2;
        case `${0x061}, 1`:
            return area_id > 15 ? NpcType.DelLily : regular ? NpcType.PoisonLily : NpcType.NarLily;
        case `${0x061}, 2`:
            return area_id > 15
                ? NpcType.DelLily
                : regular
                ? NpcType.PoisonLily2
                : NpcType.NarLily2;
        case `${0x062}, 1`:
            return NpcType.NanoDragon;
        case `${0x064}, 1`:
            return regular ? NpcType.PofuillySlime : NpcType.PouillySlime;
        case `${0x065}, 1`:
            return NpcType.PanArms;
        case `${0x065}, 2`:
            return NpcType.PanArms2;

        case `${0x081}, 1`:
            return NpcType.Garanz;
        case `${0x081}, 2`:
            return NpcType.Garanz2;
        case `${0x082}, 1`:
            return regular ? NpcType.SinowBeat : NpcType.SinowGold;
        case `${0x083}, 1`:
            return NpcType.Canadine;
        case `${0x084}, 1`:
            return NpcType.Canane;
        case `${0x085}, 1`:
            return NpcType.Dubswitch;
        case `${0x085}, 2`:
            return NpcType.Dubswitch2;

        case `${0x0a0}, 1`:
            return NpcType.Delsaber;
        case `${0x0a0}, 2`:
            return NpcType.Delsaber2;
        case `${0x0a1}, 1`:
            return NpcType.ChaosSorcerer;
        case `${0x0a1}, 2`:
            return NpcType.ChaosSorcerer2;
        case `${0x0a2}, 1`:
            return NpcType.DarkGunner;
        case `${0x0a4}, 1`:
            return NpcType.ChaosBringer;
        case `${0x0a5}, 1`:
            return NpcType.DarkBelra;
        case `${0x0a5}, 2`:
            return NpcType.DarkBelra2;
        case `${0x0a7}, 1`:
            return NpcType.Bulclaw;
        case `${0x0a8}, 1`:
            return NpcType.Claw;

        case `${0x0c0}, 1`:
            return NpcType.Dragon;
        case `${0x0c0}, 2`:
            return NpcType.GalGryphon;
        case `${0x0c1}, 1`:
            return NpcType.DeRolLe;
        // TODO:
        // case `${0x0C2}, 1`: return NpcType.VolOptPart1;
        case `${0x0c5}, 1`:
            return NpcType.VolOpt;
        case `${0x0c8}, 1`:
            return NpcType.DarkFalz;
        case `${0x0ca}, 2`:
            return NpcType.OlgaFlow;
        case `${0x0cb}, 2`:
            return NpcType.BarbaRay;
        case `${0x0cc}, 2`:
            return NpcType.GolDragon;

        case `${0x0d8}, 2`:
            return NpcType.Gibbles;
        case `${0x0d9}, 2`:
            return NpcType.Gee;
        case `${0x0da}, 2`:
            return NpcType.GiGue;

        case `${0x0db}, 2`:
            return NpcType.Deldepth;
        case `${0x0dc}, 2`:
            return NpcType.Delbiter;
        case `${0x0de}, 2`:
            return NpcType.Morfos;
        case `${0x0df}, 2`:
            return NpcType.Recobox;
        case `${0x0e1}, 2`:
            return NpcType.IllGill;

        case `${0x110}, 4`:
            return NpcType.Astark;
        case `${0x111}, 4`:
            return regular ? NpcType.SatelliteLizard : NpcType.Yowie;
        case `${0x113}, 4`:
            return NpcType.Girtablulu;
    }

    switch (type_id) {
        case 0x004:
            return NpcType.FemaleFat;
        case 0x005:
            return NpcType.FemaleMacho;
        case 0x007:
            return NpcType.FemaleTall;
        case 0x00a:
            return NpcType.MaleDwarf;
        case 0x00b:
            return NpcType.MaleFat;
        case 0x00c:
            return NpcType.MaleMacho;
        case 0x00d:
            return NpcType.MaleOld;
        case 0x019:
            return NpcType.BlueSoldier;
        case 0x01a:
            return NpcType.RedSoldier;
        case 0x01b:
            return NpcType.Principal;
        case 0x01c:
            return NpcType.Tekker;
        case 0x01d:
            return NpcType.GuildLady;
        case 0x01e:
            return NpcType.Scientist;
        case 0x01f:
            return NpcType.Nurse;
        case 0x020:
            return NpcType.Irene;
        case 0x0f1:
            return NpcType.ItemShop;
        case 0x0fe:
            return NpcType.Nurse2;
    }

    return NpcType.Unknown;
}

function objects_to_dat_data(objects: QuestObject[]): DatObject[] {
    return objects.map(object => ({
        type_id: object_data(object.type).pso_id!,
        id: object.id,
        group_id: object.group_id,
        section_id: object.section_id,
        position: object.position,
        rotation: object.rotation,
        properties: [...object.properties.values()],
        area_id: object.area_id,
        unknown: object.unknown,
    }));
}

function npcs_to_dat_data(npcs: QuestNpc[]): DatNpc[] {
    const dv = new DataView(new ArrayBuffer(4));

    return npcs.map(npc => {
        const type_data = npc_type_to_dat_data(npc.type) || {
            type_id: npc.pso_type_id,
            roaming: npc.roaming,
            regular: true,
        };

        dv.setFloat32(0, npc.scale.y);
        dv.setUint32(0, (dv.getUint32(0) & ~0x800000) | (type_data.regular ? 0 : 0x800000));
        const scale_y = dv.getFloat32(0);

        let scale = new Vec3(npc.scale.x, scale_y, npc.scale.z);

        return {
            type_id: type_data.type_id,
            section_id: npc.section_id,
            position: npc.position,
            rotation: npc.rotation,
            scale,
            npc_id: npc.npc_id,
            script_label: npc.script_label,
            roaming: type_data.roaming,
            area_id: npc.area_id,
            unknown: npc.unknown,
        };
    });
}

function npc_type_to_dat_data(
    type: NpcType,
): { type_id: number; roaming: number; regular: boolean } | undefined {
    switch (type) {
        default:
            throw new Error(`Unexpected type ${NpcType[type]}.`);

        case NpcType.Unknown:
            return undefined;

        case NpcType.FemaleFat:
            return { type_id: 0x004, roaming: 0, regular: true };
        case NpcType.FemaleMacho:
            return { type_id: 0x005, roaming: 0, regular: true };
        case NpcType.FemaleTall:
            return { type_id: 0x007, roaming: 0, regular: true };
        case NpcType.MaleDwarf:
            return { type_id: 0x00a, roaming: 0, regular: true };
        case NpcType.MaleFat:
            return { type_id: 0x00b, roaming: 0, regular: true };
        case NpcType.MaleMacho:
            return { type_id: 0x00c, roaming: 0, regular: true };
        case NpcType.MaleOld:
            return { type_id: 0x00d, roaming: 0, regular: true };
        case NpcType.BlueSoldier:
            return { type_id: 0x019, roaming: 0, regular: true };
        case NpcType.RedSoldier:
            return { type_id: 0x01a, roaming: 0, regular: true };
        case NpcType.Principal:
            return { type_id: 0x01b, roaming: 0, regular: true };
        case NpcType.Tekker:
            return { type_id: 0x01c, roaming: 0, regular: true };
        case NpcType.GuildLady:
            return { type_id: 0x01d, roaming: 0, regular: true };
        case NpcType.Scientist:
            return { type_id: 0x01e, roaming: 0, regular: true };
        case NpcType.Nurse:
            return { type_id: 0x01f, roaming: 0, regular: true };
        case NpcType.Irene:
            return { type_id: 0x020, roaming: 0, regular: true };
        case NpcType.ItemShop:
            return { type_id: 0x0f1, roaming: 0, regular: true };
        case NpcType.Nurse2:
            return { type_id: 0x0fe, roaming: 0, regular: true };

        case NpcType.Hildebear:
            return { type_id: 0x040, roaming: 0, regular: true };
        case NpcType.Hildeblue:
            return { type_id: 0x040, roaming: 1, regular: true };
        case NpcType.RagRappy:
            return { type_id: 0x041, roaming: 0, regular: true };
        case NpcType.AlRappy:
            return { type_id: 0x041, roaming: 1, regular: true };
        case NpcType.Monest:
            return { type_id: 0x042, roaming: 0, regular: true };
        case NpcType.SavageWolf:
            return { type_id: 0x043, roaming: 0, regular: true };
        case NpcType.BarbarousWolf:
            return { type_id: 0x043, roaming: 0, regular: false };
        case NpcType.Booma:
            return { type_id: 0x044, roaming: 0, regular: true };
        case NpcType.Gobooma:
            return { type_id: 0x044, roaming: 1, regular: true };
        case NpcType.Gigobooma:
            return { type_id: 0x044, roaming: 2, regular: true };
        case NpcType.Dragon:
            return { type_id: 0x0c0, roaming: 0, regular: true };

        case NpcType.GrassAssassin:
            return { type_id: 0x060, roaming: 0, regular: true };
        case NpcType.PoisonLily:
            return { type_id: 0x061, roaming: 0, regular: true };
        case NpcType.NarLily:
            return { type_id: 0x061, roaming: 1, regular: true };
        case NpcType.NanoDragon:
            return { type_id: 0x062, roaming: 0, regular: true };
        case NpcType.EvilShark:
            return { type_id: 0x063, roaming: 0, regular: true };
        case NpcType.PalShark:
            return { type_id: 0x063, roaming: 1, regular: true };
        case NpcType.GuilShark:
            return { type_id: 0x063, roaming: 2, regular: true };
        case NpcType.PofuillySlime:
            return { type_id: 0x064, roaming: 0, regular: true };
        case NpcType.PouillySlime:
            return { type_id: 0x064, roaming: 0, regular: false };
        case NpcType.PanArms:
            return { type_id: 0x065, roaming: 0, regular: true };
        case NpcType.DeRolLe:
            return { type_id: 0x0c1, roaming: 0, regular: true };

        case NpcType.Dubchic:
            return { type_id: 0x080, roaming: 0, regular: true };
        case NpcType.Gilchic:
            return { type_id: 0x080, roaming: 1, regular: true };
        case NpcType.Garanz:
            return { type_id: 0x081, roaming: 0, regular: true };
        case NpcType.SinowBeat:
            return { type_id: 0x082, roaming: 0, regular: true };
        case NpcType.SinowGold:
            return { type_id: 0x082, roaming: 0, regular: false };
        case NpcType.Canadine:
            return { type_id: 0x083, roaming: 0, regular: true };
        case NpcType.Canane:
            return { type_id: 0x084, roaming: 0, regular: true };
        case NpcType.Dubswitch:
            return { type_id: 0x085, roaming: 0, regular: true };
        case NpcType.VolOpt:
            return { type_id: 0x0c5, roaming: 0, regular: true };

        case NpcType.Delsaber:
            return { type_id: 0x0a0, roaming: 0, regular: true };
        case NpcType.ChaosSorcerer:
            return { type_id: 0x0a1, roaming: 0, regular: true };
        case NpcType.DarkGunner:
            return { type_id: 0x0a2, roaming: 0, regular: true };
        case NpcType.ChaosBringer:
            return { type_id: 0x0a4, roaming: 0, regular: true };
        case NpcType.DarkBelra:
            return { type_id: 0x0a5, roaming: 0, regular: true };
        case NpcType.Dimenian:
            return { type_id: 0x0a6, roaming: 0, regular: true };
        case NpcType.LaDimenian:
            return { type_id: 0x0a6, roaming: 1, regular: true };
        case NpcType.SoDimenian:
            return { type_id: 0x0a6, roaming: 2, regular: true };
        case NpcType.Bulclaw:
            return { type_id: 0x0a7, roaming: 0, regular: true };
        case NpcType.Claw:
            return { type_id: 0x0a8, roaming: 0, regular: true };
        case NpcType.DarkFalz:
            return { type_id: 0x0c8, roaming: 0, regular: true };

        case NpcType.Hildebear2:
            return { type_id: 0x040, roaming: 0, regular: true };
        case NpcType.Hildeblue2:
            return { type_id: 0x040, roaming: 1, regular: true };
        case NpcType.RagRappy2:
            return { type_id: 0x041, roaming: 0, regular: true };
        case NpcType.LoveRappy:
            return { type_id: 0x041, roaming: 1, regular: true };
        case NpcType.Monest2:
            return { type_id: 0x042, roaming: 0, regular: true };
        case NpcType.PoisonLily2:
            return { type_id: 0x061, roaming: 0, regular: true };
        case NpcType.NarLily2:
            return { type_id: 0x061, roaming: 1, regular: true };
        case NpcType.GrassAssassin2:
            return { type_id: 0x060, roaming: 0, regular: true };
        case NpcType.Dimenian2:
            return { type_id: 0x0a6, roaming: 0, regular: true };
        case NpcType.LaDimenian2:
            return { type_id: 0x0a6, roaming: 1, regular: true };
        case NpcType.SoDimenian2:
            return { type_id: 0x0a6, roaming: 2, regular: true };
        case NpcType.DarkBelra2:
            return { type_id: 0x0a5, roaming: 0, regular: true };
        case NpcType.BarbaRay:
            return { type_id: 0x0cb, roaming: 0, regular: true };

        case NpcType.SavageWolf2:
            return { type_id: 0x043, roaming: 0, regular: true };
        case NpcType.BarbarousWolf2:
            return { type_id: 0x043, roaming: 0, regular: false };
        case NpcType.PanArms2:
            return { type_id: 0x065, roaming: 0, regular: true };
        case NpcType.Dubchic2:
            return { type_id: 0x080, roaming: 0, regular: true };
        case NpcType.Gilchic2:
            return { type_id: 0x080, roaming: 1, regular: true };
        case NpcType.Garanz2:
            return { type_id: 0x081, roaming: 0, regular: true };
        case NpcType.Dubswitch2:
            return { type_id: 0x085, roaming: 0, regular: true };
        case NpcType.Delsaber2:
            return { type_id: 0x0a0, roaming: 0, regular: true };
        case NpcType.ChaosSorcerer2:
            return { type_id: 0x0a1, roaming: 0, regular: true };
        case NpcType.GolDragon:
            return { type_id: 0x0cc, roaming: 0, regular: true };

        case NpcType.SinowBerill:
            return { type_id: 0x0d4, roaming: 0, regular: true };
        case NpcType.SinowSpigell:
            return { type_id: 0x0d4, roaming: 1, regular: true };
        case NpcType.Merillia:
            return { type_id: 0x0d5, roaming: 0, regular: true };
        case NpcType.Meriltas:
            return { type_id: 0x0d5, roaming: 1, regular: true };
        case NpcType.Mericarol:
            return { type_id: 0x0d6, roaming: 0, regular: true };
        case NpcType.Mericus:
            return { type_id: 0x0d6, roaming: 1, regular: true };
        case NpcType.Merikle:
            return { type_id: 0x0d6, roaming: 2, regular: true };
        case NpcType.UlGibbon:
            return { type_id: 0x0d7, roaming: 0, regular: true };
        case NpcType.ZolGibbon:
            return { type_id: 0x0d7, roaming: 1, regular: true };
        case NpcType.Gibbles:
            return { type_id: 0x0d8, roaming: 0, regular: true };
        case NpcType.Gee:
            return { type_id: 0x0d9, roaming: 0, regular: true };
        case NpcType.GiGue:
            return { type_id: 0x0da, roaming: 0, regular: true };
        case NpcType.GalGryphon:
            return { type_id: 0x0c0, roaming: 0, regular: true };

        case NpcType.Deldepth:
            return { type_id: 0x0db, roaming: 0, regular: true };
        case NpcType.Delbiter:
            return { type_id: 0x0dc, roaming: 0, regular: true };
        case NpcType.Dolmolm:
            return { type_id: 0x0dd, roaming: 0, regular: true };
        case NpcType.Dolmdarl:
            return { type_id: 0x0dd, roaming: 1, regular: true };
        case NpcType.Morfos:
            return { type_id: 0x0de, roaming: 0, regular: true };
        case NpcType.Recobox:
            return { type_id: 0x0df, roaming: 0, regular: true };
        case NpcType.Epsilon:
            return { type_id: 0x0e0, roaming: 0, regular: true };
        case NpcType.SinowZoa:
            return { type_id: 0x0e0, roaming: 0, regular: true };
        case NpcType.SinowZele:
            return { type_id: 0x0e0, roaming: 1, regular: true };
        case NpcType.IllGill:
            return { type_id: 0x0e1, roaming: 0, regular: true };
        case NpcType.DelLily:
            return { type_id: 0x061, roaming: 0, regular: true };
        case NpcType.OlgaFlow:
            return { type_id: 0x0ca, roaming: 0, regular: true };

        case NpcType.SandRappy:
            return { type_id: 0x041, roaming: 0, regular: true };
        case NpcType.DelRappy:
            return { type_id: 0x041, roaming: 1, regular: true };
        case NpcType.Astark:
            return { type_id: 0x110, roaming: 0, regular: true };
        case NpcType.SatelliteLizard:
            return { type_id: 0x111, roaming: 0, regular: true };
        case NpcType.Yowie:
            return { type_id: 0x111, roaming: 0, regular: false };
        case NpcType.MerissaA:
            return { type_id: 0x112, roaming: 0, regular: true };
        case NpcType.MerissaAA:
            return { type_id: 0x112, roaming: 1, regular: true };
        case NpcType.Girtablulu:
            return { type_id: 0x113, roaming: 0, regular: true };
        case NpcType.Zu:
            return { type_id: 0x114, roaming: 0, regular: true };
        case NpcType.Pazuzu:
            return { type_id: 0x114, roaming: 1, regular: true };
        case NpcType.Boota:
            return { type_id: 0x115, roaming: 0, regular: true };
        case NpcType.ZeBoota:
            return { type_id: 0x115, roaming: 1, regular: true };
        case NpcType.BaBoota:
            return { type_id: 0x115, roaming: 2, regular: true };
        case NpcType.Dorphon:
            return { type_id: 0x116, roaming: 0, regular: true };
        case NpcType.DorphonEclair:
            return { type_id: 0x116, roaming: 1, regular: true };
        case NpcType.Goran:
            return { type_id: 0x117, roaming: 0, regular: true };
        case NpcType.PyroGoran:
            return { type_id: 0x117, roaming: 1, regular: true };
        case NpcType.GoranDetonator:
            return { type_id: 0x117, roaming: 2, regular: true };
        case NpcType.SaintMilion:
            return { type_id: 0x119, roaming: 0, regular: true };
        case NpcType.Shambertin:
            return { type_id: 0x119, roaming: 1, regular: true };
        case NpcType.Kondrieu:
            return { type_id: 0x119, roaming: 0, regular: false };
    }
}
