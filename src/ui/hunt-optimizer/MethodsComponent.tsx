import { TimePicker } from "antd";
import { observer } from "mobx-react";
import moment, { Moment } from "moment";
import React from "react";
import { AutoSizer, Index } from "react-virtualized";
import { Episode, HuntMethod } from "../../domain";
import { EnemyNpcTypes } from "../../domain/NpcType";
import { huntMethodStore } from "../../stores/HuntMethodStore";
import { BigTable, Column } from "../BigTable";
import "./MethodsComponent.css";

@observer
export class MethodsComponent extends React.Component {
    static columns: Array<Column<HuntMethod>> = (() => {
        // Standard columns.
        const columns: Column<HuntMethod>[] = [
            {
                name: 'Method',
                width: 250,
                cellRenderer: (method) => method.name,
            },
            {
                name: 'Ep.',
                width: 34,
                cellRenderer: (method) => Episode[method.episode],
            },
            {
                name: 'Time',
                width: 50,
                cellRenderer: (method) => <TimeComponent method={method} />,
                className: 'integrated',
            },
        ];

        // One column per enemy type.
        for (const enemy of EnemyNpcTypes) {
            columns.push({
                name: enemy.name,
                width: 75,
                cellRenderer: (method) => {
                    const count = method.enemyCounts.get(enemy);
                    return count == null ? '' : count.toString();
                },
                className: 'number',
            });
        }

        return columns;
    })();

    render() {
        const methods = huntMethodStore.methods.current.value;

        return (
            <section className="ho-MethodsComponent">
                <AutoSizer>
                    {({ width, height }) => (
                        <BigTable<HuntMethod>
                            width={width}
                            height={height}
                            rowCount={methods.length}
                            columns={MethodsComponent.columns}
                            fixedColumnCount={3}
                            record={this.record}
                        />
                    )}
                </AutoSizer>
            </section>
        );
    }

    private record = ({ index }: Index) => {
        return huntMethodStore.methods.current.value[index];
    }
}

@observer
class TimeComponent extends React.Component<{ method: HuntMethod }> {
    render() {
        const time = this.props.method.time;
        const hour = Math.floor(time);
        const minute = Math.round(60 * (time - hour));

        return (
            <TimePicker
                className="ho-MethodsComponent-timepicker"
                value={moment({ hour, minute })}
                format="HH:mm"
                size="small"
                allowClear={false}
                suffixIcon={<span />}
                onChange={this.change}
            />
        );
    }

    private change = (time: Moment) => {
        this.props.method.userTime = time.hour() + time.minute() / 60;
    }
}