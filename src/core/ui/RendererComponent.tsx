import React, { Component, ReactNode } from "react";
import { OrthographicCamera, PerspectiveCamera } from "three";
import { Renderer } from "../rendering/Renderer";

type Props = {
    renderer: Renderer<PerspectiveCamera | OrthographicCamera>;
    width: number;
    height: number;
    debug?: boolean;
    on_will_unmount?: () => void;
};

export class RendererComponent extends Component<Props> {
    render(): ReactNode {
        return <div className="RendererComponent" ref={this.modify_dom} />;
    }

    UNSAFE_componentWillReceiveProps(props: Props): void {
        if (this.props.debug !== props.debug) {
            this.props.renderer.debug = !!props.debug;
        }

        if (this.props.width !== props.width || this.props.height !== props.height) {
            this.props.renderer.set_size(props.width, props.height);
        }
    }

    componentDidMount(): void {
        this.props.renderer.start_rendering();
    }

    componentWillUnmount(): void {
        this.props.renderer.stop_rendering();
        this.props.on_will_unmount && this.props.on_will_unmount();
    }

    shouldComponentUpdate(): boolean {
        return false;
    }

    private modify_dom = (div: HTMLDivElement | null) => {
        if (div) {
            this.props.renderer.set_size(this.props.width, this.props.height);
            div.appendChild(this.props.renderer.dom_element);
        }
    };
}
