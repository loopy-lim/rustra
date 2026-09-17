impl PackageBuilder {
    /// Register an unchanged safe synchronous function with zero to twelve arguments.
    ///
    /// The generated TypeScript helper takes positional arguments. A `Result`
    /// returned here remains ordinary data; use [`Self::try_function`] to map errors.
    ///
    /// ```compile_fail
    /// unsafe fn privileged(value: i32) -> i32 { value }
    /// rustra::Package::builder("app").function("privileged", privileged);
    /// ```
    ///
    /// ```compile_fail
    /// #[rustra::command(capability = "secret")]
    /// fn privileged(value: i32) -> rustra::Result<i32> { Ok(value) }
    /// rustra::Package::builder("app").function("privileged", privileged);
    /// ```
    pub fn function<Args, O, F>(self, name: impl Into<String>, handler: F) -> Self
    where
        Args: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: crate::Function<Args, Output = O>,
    {
        self.register_function(name, F::ARITY, move |args| Ok(handler.call(args)))
    }

    /// Register a fallible ordinary function with an explicit domain error mapper.
    pub fn try_function<Args, O, E, F, M>(
        self,
        name: impl Into<String>,
        handler: F,
        map_error: M,
    ) -> Self
    where
        Args: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: crate::Function<Args, Output = std::result::Result<O, E>>,
        M: Fn(E) -> RustraError + Send + Sync + 'static,
    {
        self.register_function(name, F::ARITY, move |args| {
            handler.call(args).map_err(&map_error)
        })
    }

    fn register_function<Args, O, F>(
        mut self,
        name: impl Into<String>,
        arity: u8,
        handler: F,
    ) -> Self
    where
        Args: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(Args) -> crate::Result<O> + Send + Sync + 'static,
    {
        let name = name.into();
        if self.commands.contains_key(&name) {
            panic!("duplicate command registration: '{name}'");
        }
        let mut command = crate::command::build_function_command::<Args, O, _>(
            self.next_command_id,
            handler,
            arity,
        );
        command.raw_handler = None;
        command.raw_input_kinds.clear();
        self.commands.insert(name, command);
        self.next_command_id += 1;
        self
    }
}
