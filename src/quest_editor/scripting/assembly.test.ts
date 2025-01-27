import { assemble } from "./assembly";
import { InstructionSegment, SegmentType } from "./instructions";
import { Opcode } from "./opcodes";

test("basic script", () => {
    const { object_code, warnings, errors } = assemble(
        `
    0:   set_episode 0
         bb_map_designate 1, 2, 3, 4
         set_floor_handler 0, 150
         set_floor_handler 1, 151
         ret
    150: set_mainwarp 1
         ret
    151: ret
    `.split("\n"),
    );

    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);

    expect(object_code.length).toBe(3);

    const segment_0 = object_code[0] as InstructionSegment;

    expect(segment_0.type).toBe(SegmentType.Instructions);
    expect(segment_0.instructions.length).toBe(9);

    expect(segment_0.instructions[0].opcode).toBe(Opcode.SET_EPISODE);
    expect(segment_0.instructions[0].args).toEqual([{ value: 0, size: 4 }]);

    expect(segment_0.instructions[1].opcode).toBe(Opcode.BB_MAP_DESIGNATE);
    expect(segment_0.instructions[1].args).toEqual([
        { value: 1, size: 1 },
        { value: 2, size: 2 },
        { value: 3, size: 1 },
        { value: 4, size: 1 },
    ]);

    expect(segment_0.instructions[2].opcode).toBe(Opcode.ARG_PUSHL);
    expect(segment_0.instructions[2].args).toEqual([{ value: 0, size: 4 }]);
    expect(segment_0.instructions[3].opcode).toBe(Opcode.ARG_PUSHW);
    expect(segment_0.instructions[3].args).toEqual([{ value: 150, size: 2 }]);
    expect(segment_0.instructions[4].opcode).toBe(Opcode.SET_FLOOR_HANDLER);
    expect(segment_0.instructions[4].args).toEqual([]);

    expect(segment_0.instructions[5].opcode).toBe(Opcode.ARG_PUSHL);
    expect(segment_0.instructions[5].args).toEqual([{ value: 1, size: 4 }]);
    expect(segment_0.instructions[6].opcode).toBe(Opcode.ARG_PUSHW);
    expect(segment_0.instructions[6].args).toEqual([{ value: 151, size: 2 }]);
    expect(segment_0.instructions[7].opcode).toBe(Opcode.SET_FLOOR_HANDLER);
    expect(segment_0.instructions[7].args).toEqual([]);

    expect(segment_0.instructions[8].opcode).toBe(Opcode.RET);
    expect(segment_0.instructions[8].args).toEqual([]);

    const segment_1 = object_code[1] as InstructionSegment;

    expect(segment_1.type).toBe(SegmentType.Instructions);
    expect(segment_1.instructions.length).toBe(3);

    expect(segment_1.instructions[0].opcode).toBe(Opcode.ARG_PUSHL);
    expect(segment_1.instructions[0].args).toEqual([{ value: 1, size: 4 }]);
    expect(segment_1.instructions[1].opcode).toBe(Opcode.SET_MAINWARP);
    expect(segment_1.instructions[1].args).toEqual([]);

    expect(segment_1.instructions[2].opcode).toBe(Opcode.RET);
    expect(segment_1.instructions[2].args).toEqual([]);

    const segment_2 = object_code[2] as InstructionSegment;

    expect(segment_2.type).toBe(SegmentType.Instructions);
    expect(segment_2.instructions.length).toBe(1);

    expect(segment_2.instructions[0].opcode).toBe(Opcode.RET);
    expect(segment_2.instructions[0].args).toEqual([]);
});

test("pass the value of a register via the stack", () => {
    const { object_code, warnings, errors } = assemble(
        `
    0:
        leti r255, 7
        exit r255
        ret
    `.split("\n"),
    );

    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);

    expect(object_code.length).toBe(1);

    const segment_0 = object_code[0] as InstructionSegment;

    expect(segment_0.type).toBe(SegmentType.Instructions);
    expect(segment_0.instructions.length).toBe(4);

    expect(segment_0.instructions[1].opcode).toBe(Opcode.ARG_PUSHR);
    expect(segment_0.instructions[1].args).toEqual([{ value: 255, size: 1 }]);
});

test("pass a register reference via the stack", () => {
    const { object_code, warnings, errors } = assemble(
        `
    0:
        p_dead_v3 r200, 3
        ret
    `.split("\n"),
    );

    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);

    expect(object_code.length).toBe(1);

    const segment_0 = object_code[0] as InstructionSegment;

    expect(segment_0.type).toBe(SegmentType.Instructions);
    expect(segment_0.instructions.length).toBe(4);

    expect(segment_0.instructions[0].opcode).toBe(Opcode.ARG_PUSHB);
    expect(segment_0.instructions[0].args).toEqual([{ value: 200, size: 1 }]);

    expect(segment_0.instructions[1].opcode).toBe(Opcode.ARG_PUSHL);
    expect(segment_0.instructions[1].args).toEqual([{ value: 3, size: 4 }]);
});
